import { v4 as uuidv4 } from 'uuid';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { embedSafe } from '../../utils/embed-helpers.js';
import {
  TTR_WARN_SECONDS, TTI_WARN_SECONDS, REFLECTION_WARN_COUNT
} from './constants.js';

const log = createLogger('analyst:retrospective');

/**
 * Safely parse a date value, returning null on invalid input.
 *
 * @param {*} value - Date string or value to parse
 * @returns {Date|null} Valid Date or null
 */
function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Run incident retrospective generation.
 *
 * Produces a structured post-mortem for every terminal incident:
 * timeline, timing metrics, agent performance, remediation effectiveness,
 * root cause accuracy, and improvement recommendations.
 *
 * @param {object} incidentData - Full incident document from vigil-incidents
 * @returns {Promise<object>} Learning record written
 */
export async function runRetrospective(incidentData) {
  const incidentId = incidentData.incident_id || 'unknown';
  const terminalState = incidentData.status;

  log.info(`Generating retrospective for ${incidentId} (${terminalState})`);

  // Build timeline from state timestamps
  const stateTimestamps = incidentData._state_timestamps || {};
  const timeline = {};
  for (const [state, timestamp] of Object.entries(stateTimestamps)) {
    timeline[state] = timestamp;
  }
  // Ensure created_at is in the timeline
  if (incidentData.created_at && !timeline.detected) {
    timeline.detected = incidentData.created_at;
  }

  // Compute timing metrics
  const timingMetrics = computeTimingMetrics(incidentData, stateTimestamps);

  // Query agent telemetry (graceful degradation)
  const [telemetryResult] = await Promise.allSettled([
    queryAgentTelemetry(incidentId)
  ]);
  const agentPerformance = telemetryResult.status === 'fulfilled'
    ? telemetryResult.value : [];
  if (telemetryResult.status === 'rejected') {
    log.warn(`Agent telemetry unavailable for ${incidentId}: ${telemetryResult.reason?.message}`);
  }

  // Assess remediation effectiveness
  const reflectionCount = incidentData.reflection_count || 0;
  const firstAttemptSuccess = reflectionCount === 0 && terminalState === 'resolved';

  const verificationResults = incidentData.verification_results || [];
  const lastVerification = verificationResults[verificationResults.length - 1];
  const finalHealthScore = lastVerification?.health_score
    ?? incidentData.verification?.health_score
    ?? null;

  // Assess root cause accuracy
  const rootCause = incidentData.root_cause || incidentData.investigation_summary || null;
  const rootCauseAccurate = assessRootCauseAccuracy(incidentData);

  // Generate improvement recommendations
  const recommendations = generateRecommendations(
    incidentData, reflectionCount, timingMetrics, agentPerformance
  );

  // Build summary
  const severity = incidentData.severity || 'unknown';
  const incidentType = incidentData.incident_type || 'unknown';
  const totalSeconds = timingMetrics.total_seconds || incidentData.total_duration_seconds || 0;
  const durationStr = formatDuration(totalSeconds);

  const summary =
    `${incidentId}: ${incidentType} incident (${severity}). ` +
    `${terminalState === 'resolved' ? 'Resolved autonomously' : `Terminal state: ${terminalState}`} ` +
    `in ${durationStr}${reflectionCount > 0 ? ` with ${reflectionCount} reflection loop(s)` : ' with no reflection loops'}. ` +
    `${firstAttemptSuccess ? 'First-attempt success.' : ''} ` +
    `${finalHealthScore !== null ? `Final health score: ${finalHealthScore}.` : ''} ` +
    `${recommendations.length} improvement recommendation(s).`.replace(/\s+/g, ' ').trim();

  const confidence = computeRetrospectiveConfidence(incidentData, agentPerformance);

  const vector = await embedSafe(summary, log, 'summary_vector');

  const now = new Date().toISOString();

  const learningRecord = {
    '@timestamp': now,
    learning_id: `LRN-RET-${uuidv4().slice(0, 8).toUpperCase()}`,
    learning_type: 'retrospective',
    incident_ids: [incidentId],
    analysis_window: {
      start: incidentData.created_at || now,
      end: incidentData.resolved_at || now,
      incident_count: 1
    },
    summary,
    confidence: Math.round(confidence * 100) / 100,
    data: {
      incident_id: incidentId,
      incident_type: incidentType,
      severity,
      terminal_state: terminalState,
      timeline,
      timing_metrics: timingMetrics,
      agent_performance: agentPerformance,
      reflection_loops: reflectionCount,
      first_attempt_success: firstAttemptSuccess,
      final_health_score: finalHealthScore,
      root_cause: rootCause,
      root_cause_accurate: rootCauseAccurate.accurate,
      root_cause_assessment_basis: rootCauseAccurate.basis,
      remediation_actions: extractActionSummary(incidentData),
      improvement_recommendations: recommendations
    },
    applied: false,
    applied_at: null,
    reviewed_by: null,
    review_status: 'informational'
  };

  if (vector) {
    learningRecord.summary_vector = vector;
  }

  try {
    await withRetry(() => client.index({
      index: 'vigil-learnings',
      id: learningRecord.learning_id,
      document: learningRecord,
      op_type: 'create',
      refresh: 'wait_for'
    }), { label: `index ${learningRecord.learning_id}` });
  } catch (err) {
    if (err.meta?.statusCode === 409) {
      log.info(`${learningRecord.learning_id} already exists — skipping duplicate write`);
      return learningRecord;
    }
    throw err;
  }

  log.info(`Retrospective written: ${learningRecord.learning_id} for ${incidentId}`);

  return learningRecord;
}

/**
 * Compute timing metrics: TTD, TTI, TTR, TTV, total_seconds.
 * Uses safeDate to guard against NaN from malformed date strings.
 */
function computeTimingMetrics(incidentData, stateTimestamps) {
  const metrics = {
    ttd_seconds: null,
    tti_seconds: null,
    ttr_seconds: null,
    ttv_seconds: null,
    total_seconds: null
  };

  const created = safeDate(incidentData.created_at);
  const detected = safeDate(stateTimestamps.detected);
  const triaged = safeDate(stateTimestamps.triaged);
  const investigating = safeDate(stateTimestamps.investigating);
  const executing = safeDate(stateTimestamps.executing);
  const verifying = safeDate(stateTimestamps.verifying);
  const resolved = safeDate(incidentData.resolved_at);

  // TTD: Time to Detect (created → detected/triaged)
  // Handle clock skew: use the earlier of detected/triaged
  if (created && (detected || triaged)) {
    const end = detected && triaged
      ? new Date(Math.min(detected.getTime(), triaged.getTime()))
      : (detected || triaged);
    metrics.ttd_seconds = Math.max(0, Math.floor((end - created) / 1000));
  }

  // TTI: Time to Investigate (triaged → executing)
  if (triaged && executing) {
    metrics.tti_seconds = Math.max(0, Math.floor((executing - triaged) / 1000));
  } else if (investigating && executing) {
    metrics.tti_seconds = Math.max(0, Math.floor((executing - investigating) / 1000));
  }

  // TTR: Time to Remediate (executing → verifying)
  if (executing && verifying) {
    metrics.ttr_seconds = Math.max(0, Math.floor((verifying - executing) / 1000));
  }

  // TTV: Time to Verify (verifying → resolved)
  if (verifying && resolved) {
    metrics.ttv_seconds = Math.max(0, Math.floor((resolved - verifying) / 1000));
  }

  // Total
  if (created && resolved) {
    metrics.total_seconds = Math.max(0, Math.floor((resolved - created) / 1000));
  } else if (incidentData.total_duration_seconds) {
    metrics.total_seconds = incidentData.total_duration_seconds;
  }

  return metrics;
}

/**
 * Query agent telemetry for an incident using aggregations.
 * Uses ES aggregations instead of fetching raw hits to avoid the 50-hit ceiling.
 *
 * @param {string} incidentId
 * @returns {Promise<Array<object>>} Agent performance entries
 */
async function queryAgentTelemetry(incidentId) {
  try {
    const result = await client.search({
      index: 'vigil-agent-telemetry',
      query: { term: { incident_id: incidentId } },
      size: 0,
      timeout: '30s',
      aggs: {
        by_agent: {
          terms: { field: 'agent_name', size: 20 },
          aggs: {
            total_exec_ms: { sum: { field: 'execution_time_ms' } },
            total_calls: { value_count: { field: 'agent_name' } },
            error_count: { filter: { term: { status: 'error' } } }
          }
        }
      }
    });

    return (result.aggregations?.by_agent?.buckets || []).map(bucket => ({
      agent: bucket.key,
      execution_ms: bucket.total_exec_ms?.value || 0,
      tools_called: bucket.total_calls?.value || 0,
      errors: bucket.error_count?.doc_count || 0
    }));
  } catch (err) {
    if (err.meta?.statusCode === 404) {
      log.info('vigil-agent-telemetry index not found — telemetry not yet available');
      return [];
    }
    throw err;
  }
}

/**
 * Assess root cause accuracy by comparing investigation findings against outcome.
 *
 * @param {object} incidentData
 * @returns {{ accurate: boolean|null, basis: string }}
 */
function assessRootCauseAccuracy(incidentData) {
  if (incidentData.status === 'resolved' && (incidentData.reflection_count || 0) === 0) {
    return { accurate: true, basis: 'inferred_from_first_attempt_success' };
  }
  if (incidentData.status === 'escalated') {
    return { accurate: false, basis: 'inferred_from_escalation' };
  }
  if (incidentData.status === 'resolved' && incidentData.reflection_count > 0) {
    return { accurate: null, basis: 'indeterminate_required_reflection' };
  }
  return { accurate: null, basis: 'indeterminate_suppressed' };
}

/**
 * Generate improvement recommendations based on incident characteristics.
 */
function generateRecommendations(incidentData, reflectionCount, timingMetrics, agentPerformance) {
  const recommendations = [];

  // High reflection count suggests the initial plan was inadequate
  if (reflectionCount >= REFLECTION_WARN_COUNT) {
    recommendations.push(
      'High reflection count suggests the initial remediation plan was inadequate. ' +
      'Consider creating a targeted runbook for this incident type.'
    );
  }

  // Slow TTR suggests remediation bottleneck
  if (timingMetrics.ttr_seconds && timingMetrics.ttr_seconds > TTR_WARN_SECONDS) {
    recommendations.push(
      `Remediation took ${formatDuration(timingMetrics.ttr_seconds)}. ` +
      'Consider automating common remediation steps or pre-approving low-risk actions.'
    );
  }

  // Slow TTI suggests investigation bottleneck
  if (timingMetrics.tti_seconds && timingMetrics.tti_seconds > TTI_WARN_SECONDS) {
    recommendations.push(
      `Investigation phase took ${formatDuration(timingMetrics.tti_seconds)}. ` +
      'Consider adding more specific ES|QL queries or enriching alert context at triage.'
    );
  }

  // Missing telemetry indicates monitoring gaps
  if (agentPerformance.length === 0) {
    recommendations.push(
      'No agent telemetry found for this incident. Ensure all agents emit telemetry records.'
    );
  }

  // Agent errors indicate tool reliability issues
  const errorAgents = agentPerformance.filter(a => a.errors > 0);
  if (errorAgents.length > 0) {
    const names = errorAgents.map(a => `${a.agent} (${a.errors} errors)`).join(', ');
    recommendations.push(
      `Agent errors detected: ${names}. Review tool configurations and error handling.`
    );
  }

  // Escalation indicates Vigil couldn't resolve autonomously
  if (incidentData.status === 'escalated') {
    const reason = incidentData.escalation_reason || 'unknown reason';
    recommendations.push(
      `Incident was escalated (${reason}). ` +
      'Analyze the escalation cause to improve autonomous resolution capability.'
    );
  }

  // No runbook match and resolved — good candidate for runbook generation
  const matchScore = incidentData.remediation_plan?.runbook_match_score ?? null;
  if (matchScore !== null && matchScore < 0.5 && incidentData.status === 'resolved') {
    recommendations.push(
      `Commander had low runbook match (${matchScore}). ` +
      'A new runbook should be auto-generated from this successful remediation.'
    );
  }

  return recommendations;
}

/**
 * Extract action type summary from remediation plan.
 */
function extractActionSummary(incidentData) {
  const actions = incidentData.remediation_plan?.actions || [];
  return actions.map(a => a.action_type || a.description || 'unknown').filter(Boolean);
}

/**
 * Compute retrospective confidence based on data completeness.
 */
function computeRetrospectiveConfidence(incidentData, agentPerformance) {
  let score = 0.5; // base

  // More data = higher confidence
  if (incidentData._state_timestamps) score += 0.1;
  if (incidentData.remediation_plan?.actions?.length > 0) score += 0.1;
  if (incidentData.verification_results?.length > 0) score += 0.1;
  if (agentPerformance.length > 0) score += 0.1;
  if (incidentData.root_cause || incidentData.investigation_summary) score += 0.05;

  return Math.min(0.95, score);
}

/**
 * Format seconds into a human-readable duration string.
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && h === 0) parts.push(`${s}s`);
  return parts.join('') || '0s';
}
