import 'dotenv/config';
import { createLogger } from '../../../utils/logger.js';
import { executeEsqlTool } from '../../../tools/esql/executor.js';
import {
  buildColIndex, rowToObject, generateReportId,
  generateNarrative, buildReportEnvelope, indexReport,
  executeSecondaryEsql, getWeekNumber, withDeadline
} from '../narrative.js';
import { deliverReport } from '../delivery.js';

const log = createLogger('reporter-ops-trends');

// Secondary queries

const DEPLOYMENT_CORRELATION_QUERY = `FROM vigil-investigations
| WHERE created_at >= ?window_start AND created_at <= ?window_end
  AND change_correlation.matched == true
| STATS
    deployment_incidents = COUNT(*),
    avg_time_gap = AVG(change_correlation.time_gap_seconds)
  BY affected_service
| SORT deployment_incidents DESC`;

const RUNBOOK_UTILIZATION_QUERY = `FROM vigil-actions-*
| WHERE @timestamp >= ?window_start AND @timestamp <= ?window_end
  AND runbook_id IS NOT NULL
| STATS
    times_used = COUNT(*),
    successes = COUNT_IF(status == "success")
  BY runbook_id
| EVAL success_rate = ROUND(successes * 100.0 / times_used, 1)
| SORT times_used DESC`;

/**
 * Generate an operational trends report.
 *
 * @param {string} windowStart - ISO 8601 start
 * @param {string} windowEnd - ISO 8601 end
 * @param {string} triggerType - scheduled_weekly or on_demand
 * @returns {Promise<object>} Report document
 */
export async function generateOperationalTrends(windowStart, windowEnd, triggerType, options = {}) {
  return withDeadline(async () => {
  const startTime = Date.now();
  log.info('Generating operational trends report', { windowStart, windowEnd, triggerType });

  const params = { window_start: windowStart, window_end: windowEnd };

  // 1. Run all three queries in parallel
  const [serviceResult, deployResult, runbookResult] = await Promise.allSettled([
    executeEsqlTool('vigil-report-operational-trends', params),
    executeSecondaryEsql(DEPLOYMENT_CORRELATION_QUERY, params),
    executeSecondaryEsql(RUNBOOK_UTILIZATION_QUERY, params)
  ]);

  // 2. Process per-service metrics
  let serviceData = [];
  if (serviceResult.status === 'fulfilled' && serviceResult.value.values.length > 0) {
    const { columns, values } = serviceResult.value;
    const colIdx = buildColIndex(columns, [
      'affected_service', 'incident_count', 'avg_ttr', 'avg_reflections', 'escalated'
    ], 'ops-service');
    serviceData = values.map(row => {
      const obj = rowToObject(row, colIdx);
      return {
        service: obj.affected_service,
        incident_count: obj.incident_count ?? 0,
        avg_ttr_seconds: Math.round(obj.avg_ttr ?? 0),
        avg_reflections: Math.round((obj.avg_reflections ?? 0) * 10) / 10,
        escalated: obj.escalated ?? 0
      };
    });
  }

  // 3. Process deployment correlation
  let deployData = [];
  if (deployResult.status === 'fulfilled' && deployResult.value.values.length > 0) {
    const { columns, values } = deployResult.value;
    const colIdx = buildColIndex(columns, [
      'affected_service', 'deployment_incidents', 'avg_time_gap'
    ], 'ops-deploy');
    deployData = values.map(row => {
      const obj = rowToObject(row, colIdx);
      return {
        service: obj.affected_service,
        deployment_incidents: obj.deployment_incidents ?? 0,
        avg_time_gap_seconds: Math.round(obj.avg_time_gap ?? 0)
      };
    });
  }

  // 4. Process runbook utilization
  let runbookData = [];
  if (runbookResult.status === 'fulfilled' && runbookResult.value.values.length > 0) {
    const { columns, values } = runbookResult.value;
    const colIdx = buildColIndex(columns, [
      'runbook_id', 'times_used', 'successes', 'success_rate'
    ], 'ops-runbook');
    runbookData = values.map(row => {
      const obj = rowToObject(row, colIdx);
      return {
        runbook_id: obj.runbook_id,
        times_used: obj.times_used ?? 0,
        successes: obj.successes ?? 0,
        success_rate: obj.success_rate ?? 0
      };
    });
  }

  // 5. Generate narratives in parallel
  const [serviceNarr, deployNarr, runbookNarr] = await Promise.allSettled([
    generateNarrative('per_service_metrics', { services: serviceData }),
    generateNarrative('deployment_correlation', { deployments: deployData }),
    generateNarrative('runbook_utilization', { runbooks: runbookData })
  ]);

  // 6. Assemble sections
  const sections = [
    {
      section_id: 'per-service-metrics',
      title: 'Per-Service Operational Metrics',
      narrative: serviceNarr.status === 'fulfilled' ? serviceNarr.value : 'See data table.',
      data: { services: serviceData },
      source_query: `FROM vigil-incidents | WHERE created_at >= '${windowStart}' AND created_at <= '${windowEnd}' AND incident_type == "operational" | STATS incident_count = COUNT(*), avg_ttr = AVG(ttr_seconds), avg_reflections = AVG(reflection_count), escalated = COUNT_IF(status == "escalated") BY affected_service | SORT incident_count DESC`,
      compliance_controls: []
    },
    {
      section_id: 'deployment-correlation',
      title: 'Deployment-Correlated Incidents',
      narrative: deployNarr.status === 'fulfilled' ? deployNarr.value : 'See data table.',
      data: { deployments: deployData },
      source_query: `FROM vigil-investigations | WHERE created_at >= '${windowStart}' AND change_correlation.matched == true | STATS deployment_incidents = COUNT(*), avg_time_gap = AVG(change_correlation.time_gap_seconds) BY affected_service`,
      compliance_controls: []
    },
    {
      section_id: 'runbook-utilization',
      title: 'Runbook Utilization',
      narrative: runbookNarr.status === 'fulfilled' ? runbookNarr.value : 'See data table.',
      data: { runbooks: runbookData },
      source_query: `FROM vigil-actions-* | WHERE @timestamp >= '${windowStart}' AND runbook_id IS NOT NULL | STATS times_used = COUNT(*), successes = COUNT_IF(status == "success") BY runbook_id`,
      compliance_controls: []
    }
  ];

  // 7. Build report
  const reportId = generateReportId('OPS', windowEnd, triggerType);
  const totalIncidents = serviceData.reduce((sum, s) => sum + s.incident_count, 0);
  const report = buildReportEnvelope({
    reportId,
    reportType: 'operational_trends',
    title: `Operational Trends Report — Week ${String(getWeekNumber(windowEnd)).padStart(2, '0')}, ${new Date(windowEnd).getUTCFullYear()}`,
    windowStart,
    windowEnd,
    triggerType,
    sections,
    metadata: {
      incident_count: totalIncidents,
      data_sources: ['vigil-incidents', 'vigil-investigations', 'vigil-actions-*'],
      methodology: `Aggregated operational incidents by affected_service within the reporting window (${windowStart} to ${windowEnd}). Deployment correlation from vigil-investigations where change_correlation.matched == true. Runbook utilization from vigil-actions-* where runbook_id is present.`,
      token_estimate: 2000
    }
  });

  // 8. Index and deliver
  try { await indexReport(report); } catch (err) { log.error(`Failed to index ops trends: ${err.message}`); }
  try { await deliverReport(report); } catch (err) { log.error(`Failed to deliver ops trends: ${err.message}`); }

  const elapsed = Date.now() - startTime;
  log.info(`Operational trends report generated: ${reportId}`, { incident_count: totalIncidents, elapsed_ms: elapsed });

  return report;
  }, options);
}
