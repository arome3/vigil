import { getIncident } from '../../state-machine/transitions.js';
import { computeTimingMetrics } from './timing.js';
import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('coordinator-reporting');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchActionsForIncident(incidentId) {
  const actions = [];
  let searchAfter = null;
  const MAX_PAGES = 20;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = {
        index: 'vigil-actions',
        size: 100,
        query: { term: { incident_id: incidentId } },
        sort: [{ '@timestamp': 'asc' }, { _id: 'asc' }]
      };
      if (searchAfter) query.search_after = searchAfter;

      const result = await client.search(query);
      const hits = result.hits?.hits || [];
      if (hits.length === 0) break;

      actions.push(...hits.map(h => h._source));
      searchAfter = hits[hits.length - 1].sort;
    }
  } catch (err) {
    log.warn(`Failed to fetch actions for ${incidentId}: ${err.message}`);
    return actions; // return what we have so far
  }
  return actions;
}

function deriveAgentsInvolved(actions) {
  const agents = new Set();
  for (const action of actions) {
    if (action.agent_name) {
      agents.add(action.agent_name);
    }
  }
  return [...agents];
}

// ---------------------------------------------------------------------------
// Report validation
// ---------------------------------------------------------------------------

function validateReport(report) {
  const errors = [];

  if (!report.report_id || typeof report.report_id !== 'string') {
    errors.push('report_id must be a non-empty string');
  }
  if (!report.incident_id || typeof report.incident_id !== 'string') {
    errors.push('incident_id must be a non-empty string');
  }
  if (!report.summary || typeof report.summary !== 'object') {
    errors.push('summary must be an object');
  } else {
    if (typeof report.summary.incident_type !== 'string') errors.push('summary.incident_type must be a string');
    if (typeof report.summary.severity !== 'string') errors.push('summary.severity must be a string');
    if (typeof report.summary.resolution_type !== 'string') errors.push('summary.resolution_type must be a string');
    if (typeof report.summary.reflection_count !== 'number') errors.push('summary.reflection_count must be a number');
  }
  if (!report.timing_metrics || typeof report.timing_metrics !== 'object') {
    errors.push('timing_metrics must be an object');
  }
  if (!Array.isArray(report.actions_taken)) {
    errors.push('actions_taken must be an array');
  }
  if (!Array.isArray(report.affected_services)) {
    errors.push('affected_services must be an array');
  }
  if (!Array.isArray(report.agents_involved)) {
    errors.push('agents_involved must be an array');
  }
  if (typeof report.generated_at !== 'string') {
    errors.push('generated_at must be a string');
  }

  if (errors.length > 0) {
    throw new Error(`Report validation failed: ${errors.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Telemetry (best-effort, never throws)
// ---------------------------------------------------------------------------

async function indexTelemetry(data) {
  try {
    await client.index({
      index: 'vigil-watcher-telemetry',
      document: {
        '@timestamp': new Date().toISOString(),
        component: 'coordinator-reporting',
        ...data
      }
    });
  } catch (err) {
    log.debug(`Telemetry indexing failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// generateIncidentReport
// ---------------------------------------------------------------------------

export async function generateIncidentReport(incidentId) {
  const startTime = Date.now();
  const { doc } = await getIncident(incidentId);
  const actions = await fetchActionsForIncident(incidentId);
  const timingMetrics = computeTimingMetrics(doc);

  const report = {
    report_id: `RPT-${incidentId}`,
    incident_id: incidentId,
    summary: {
      incident_type: doc.incident_type,
      severity: doc.severity,
      root_cause: doc.investigation_summary || 'Unknown',
      resolution_type: doc.resolution_type,
      total_duration: timingMetrics.total_duration_seconds,
      reflection_count: doc.reflection_count || 0
    },
    timing_metrics: timingMetrics,
    actions_taken: actions,
    affected_services: doc.affected_services || [],
    agents_involved: deriveAgentsInvolved(actions),
    generated_at: new Date().toISOString()
  };

  validateReport(report);

  try {
    await client.index({
      index: 'vigil-reports',
      id: report.report_id,
      document: report,
      refresh: 'wait_for'
    });
    log.info(`Indexed incident report ${report.report_id}`);
  } catch (err) {
    log.error(`Failed to index report ${report.report_id}: ${err.message}`);
    throw err;
  }

  await indexTelemetry({
    incident_id: incidentId,
    report_id: report.report_id,
    actions_count: actions.length,
    agents_involved_count: report.agents_involved.length,
    generation_duration_ms: Date.now() - startTime
  });

  return report;
}

// ---------------------------------------------------------------------------
// triggerReportingWorkflow
// ---------------------------------------------------------------------------

export async function triggerReportingWorkflow(incidentId, report) {
  const payload = {
    task: 'generate_report',
    incident_id: incidentId,
    report_id: report.report_id,
    severity: report.summary.severity,
    resolution_type: report.summary.resolution_type
  };

  const envelope = createEnvelope(
    'vigil-coordinator',
    'vigil-wf-reporting',
    incidentId,
    payload
  );

  try {
    await sendA2AMessage('vigil-wf-reporting', envelope);
    log.info(`Reporting workflow triggered for ${incidentId}`);
  } catch (err) {
    log.warn(`Reporting workflow trigger failed for ${incidentId}: ${err.message} (report already indexed)`);
  }
}
