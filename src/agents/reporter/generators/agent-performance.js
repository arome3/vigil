import 'dotenv/config';
import { createLogger } from '../../../utils/logger.js';
import { executeEsqlTool } from '../../../tools/esql/executor.js';
import {
  buildColIndex, rowToObject, generateReportId,
  generateNarrative, buildReportEnvelope, indexReport,
  executeSecondaryEsql, getWeekNumber, withDeadline
} from '../narrative.js';
import { deliverReport } from '../delivery.js';

const log = createLogger('reporter-agent-perf');

// Secondary queries

const TRIAGE_ACCURACY_QUERY = `FROM vigil-learnings
| WHERE learning_type == "weight_calibration"
  AND @timestamp >= ?window_start AND @timestamp <= ?window_end
| SORT @timestamp DESC
| LIMIT 1
| KEEP data.accuracy_current, data.confusion_matrix, confidence`;

const VERIFIER_EFFECTIVENESS_QUERY = `FROM vigil-incidents
| WHERE created_at >= ?window_start AND created_at <= ?window_end
  AND status == "resolved"
| STATS
    total_resolved = COUNT(*),
    first_attempt_pass = COUNT_IF(reflection_count == 0),
    required_reflection = COUNT_IF(reflection_count > 0),
    avg_health_score = AVG(verification.health_score)
| EVAL first_attempt_rate = CASE(total_resolved == 0, 0.0, ROUND(first_attempt_pass * 100.0 / total_resolved, 1))`;

/**
 * Generate an agent performance report.
 *
 * @param {string} windowStart - ISO 8601 start
 * @param {string} windowEnd - ISO 8601 end
 * @param {string} triggerType - scheduled_weekly or on_demand
 * @returns {Promise<object>} Report document
 */
export async function generateAgentPerformance(windowStart, windowEnd, triggerType, options = {}) {
  return withDeadline(async () => {
  const startTime = Date.now();
  log.info('Generating agent performance report', { windowStart, windowEnd, triggerType });

  const params = { window_start: windowStart, window_end: windowEnd };

  // 1. Run all three queries in parallel
  const [telemetryResult, triageResult, verifierResult] = await Promise.allSettled([
    executeEsqlTool('vigil-report-agent-performance', params),
    executeSecondaryEsql(TRIAGE_ACCURACY_QUERY, params),
    executeSecondaryEsql(VERIFIER_EFFECTIVENESS_QUERY, params)
  ]);

  // 2. Process per-agent telemetry
  let agentData = [];
  if (telemetryResult.status === 'fulfilled' && telemetryResult.value.values.length > 0) {
    const { columns, values } = telemetryResult.value;
    const colIdx = buildColIndex(columns, [
      'agent_name', 'total_invocations', 'avg_execution_ms',
      'p95_execution_ms', 'p99_execution_ms', 'total_tool_calls',
      'successes', 'failures', 'success_rate', 'avg_execution_seconds'
    ], 'agent-telemetry');
    agentData = values.map(row => {
      const obj = rowToObject(row, colIdx);
      return {
        agent: obj.agent_name,
        total_invocations: obj.total_invocations ?? 0,
        avg_execution_seconds: obj.avg_execution_seconds ?? 0,
        p95_execution_ms: Math.round(obj.p95_execution_ms ?? 0),
        p99_execution_ms: Math.round(obj.p99_execution_ms ?? 0),
        total_tool_calls: obj.total_tool_calls ?? 0,
        success_rate: obj.success_rate ?? 0,
        failures: obj.failures ?? 0
      };
    });
  }

  // 3. Process triage accuracy
  let triageData = { accuracy_current: null, confidence: null };
  if (triageResult.status === 'fulfilled' && triageResult.value.values.length > 0) {
    const { columns, values } = triageResult.value;
    const colIdx = buildColIndex(columns, ['data.accuracy_current', 'confidence'], 'triage-accuracy');
    const row = rowToObject(values[0], colIdx);
    triageData = {
      accuracy_current: row['data.accuracy_current'] ?? null,
      confusion_matrix: row['data.confusion_matrix'] ?? null,
      confidence: row.confidence ?? null
    };
  }

  // 4. Process verifier effectiveness
  let verifierData = {
    total_resolved: 0, first_attempt_pass: 0,
    required_reflection: 0, avg_health_score: null, first_attempt_rate: 0
  };
  if (verifierResult.status === 'fulfilled' && verifierResult.value.values.length > 0) {
    const { columns, values } = verifierResult.value;
    const colIdx = buildColIndex(columns, [
      'total_resolved', 'first_attempt_pass', 'required_reflection',
      'avg_health_score', 'first_attempt_rate'
    ], 'verifier-effectiveness');
    verifierData = rowToObject(values[0], colIdx);
  }

  // 5. Generate narratives in parallel
  const [agentNarr, triageNarr, verifierNarr] = await Promise.allSettled([
    generateNarrative('agent_execution_metrics', { agents: agentData }),
    generateNarrative('triage_accuracy', triageData),
    generateNarrative('verifier_effectiveness', verifierData)
  ]);

  // 6. Assemble sections
  const sections = [
    {
      section_id: 'agent-execution-metrics',
      title: 'Agent Execution Metrics',
      narrative: agentNarr.status === 'fulfilled' ? agentNarr.value : 'See data table.',
      data: { agents: agentData },
      source_query: `FROM vigil-agent-telemetry | WHERE @timestamp >= '${windowStart}' AND @timestamp <= '${windowEnd}' | STATS total_invocations = COUNT(*), avg_execution_ms = AVG(duration_ms), p95_execution_ms = PERCENTILE(duration_ms, 95), p99_execution_ms = PERCENTILE(duration_ms, 99), total_tool_calls = SUM(tool_call_count), successes = COUNT_IF(outcome == "success"), failures = COUNT_IF(outcome == "failure") BY agent_name`,
      compliance_controls: []
    },
    {
      section_id: 'triage-accuracy',
      title: 'Triage Accuracy',
      narrative: triageNarr.status === 'fulfilled' ? triageNarr.value : 'See data.',
      data: triageData,
      source_query: `FROM vigil-learnings | WHERE learning_type == "weight_calibration" AND @timestamp >= '${windowStart}' | SORT @timestamp DESC | LIMIT 1`,
      compliance_controls: []
    },
    {
      section_id: 'verifier-effectiveness',
      title: 'Verifier Effectiveness',
      narrative: verifierNarr.status === 'fulfilled' ? verifierNarr.value : 'See data.',
      data: verifierData,
      source_query: `FROM vigil-incidents | WHERE created_at >= '${windowStart}' AND status == "resolved" | STATS total_resolved = COUNT(*), first_attempt_pass = COUNT_IF(reflection_count == 0), ... | EVAL first_attempt_rate = ...`,
      compliance_controls: []
    }
  ];

  // 7. Build report
  const reportId = generateReportId('AGENT', windowEnd, triggerType);
  const totalInvocations = agentData.reduce((sum, a) => sum + a.total_invocations, 0);
  const report = buildReportEnvelope({
    reportId,
    reportType: 'agent_performance',
    title: `Agent Performance Report — Week ${String(getWeekNumber(windowEnd)).padStart(2, '0')}, ${new Date(windowEnd).getUTCFullYear()}`,
    windowStart,
    windowEnd,
    triggerType,
    sections,
    metadata: {
      incident_count: verifierData.total_resolved ?? 0,
      data_sources: ['vigil-agent-telemetry', 'vigil-learnings', 'vigil-incidents'],
      methodology: `Per-agent metrics aggregated from vigil-agent-telemetry within ${windowStart} to ${windowEnd}. Triage accuracy from the latest weight_calibration learning. Verifier effectiveness from resolved incidents in the window.`,
      token_estimate: 1800
    }
  });

  // 8. Index and deliver
  try { await indexReport(report); } catch (err) { log.error(`Failed to index agent perf: ${err.message}`); }
  try { await deliverReport(report); } catch (err) { log.error(`Failed to deliver agent perf: ${err.message}`); }

  const elapsed = Date.now() - startTime;
  log.info(`Agent performance report generated: ${reportId}`, { total_invocations: totalInvocations, elapsed_ms: elapsed });

  return report;
  }, options);
}
