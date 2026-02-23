import 'dotenv/config';
import { createLogger } from '../../../utils/logger.js';
import { executeEsqlTool } from '../../../tools/esql/executor.js';
import {
  buildColIndex, rowToObject, generateReportId,
  generateNarrative, buildReportEnvelope, indexReport,
  executeSecondaryEsql, withDeadline
} from '../narrative.js';
import { deliverReport } from '../delivery.js';

const log = createLogger('reporter-incident-detail');

// Secondary queries

const ACTION_TIMELINE_QUERY = `FROM vigil-actions-*
| WHERE incident_id == ?incident_id
| SORT @timestamp ASC
| KEEP
    @timestamp, action_id, agent_name, action_type, action_detail,
    target_system, target_asset, approval_required, approved_by,
    status, duration_ms, workflow_id, result_summary, rollback_available`;

const RETROSPECTIVE_QUERY = `FROM vigil-learnings
| WHERE learning_type == "retrospective" AND incident_ids == ?incident_id
| KEEP summary, data.timeline, data.agent_performance, data.improvement_recommendations, confidence`;

/**
 * Generate a detailed incident export report.
 *
 * @param {string} incidentId - Incident ID to export
 * @returns {Promise<object>} Report document
 */
export async function generateIncidentDetailExport(incidentId, options = {}) {
  return withDeadline(async () => {
  const startTime = Date.now();
  log.info('Generating incident detail export', { incidentId });

  const params = { incident_id: incidentId };

  // 1. Run all three queries in parallel
  const [incidentResult, actionsResult, retroResult] = await Promise.allSettled([
    executeEsqlTool('vigil-report-incident-detail-export', params),
    executeSecondaryEsql(ACTION_TIMELINE_QUERY, params),
    executeSecondaryEsql(RETROSPECTIVE_QUERY, params)
  ]);

  // 2. Process incident data
  let incidentData = {};
  if (incidentResult.status === 'fulfilled' && incidentResult.value.values.length > 0) {
    const { columns, values } = incidentResult.value;
    const colIdx = buildColIndex(columns, [
      'incident_id', 'status', 'severity', 'incident_type', 'priority_score',
      'created_at', 'resolved_at', 'total_duration_seconds',
      'ttd_seconds', 'tti_seconds', 'ttr_seconds', 'ttv_seconds',
      'agents_involved', 'reflection_count', 'resolution_type',
      'alert_ids', 'affected_assets', 'investigation', 'remediation_plan', 'verification_results'
    ], 'incident-detail');
    incidentData = rowToObject(values[0], colIdx);
  } else {
    log.warn(`No incident found for ${incidentId}`);
    incidentData = { incident_id: incidentId, status: 'not_found' };
  }

  if (incidentData.status === 'not_found') {
    log.error(`Incident ${incidentId} not found — aborting detail export`);
    return {
      report_id: null,
      error: 'incident_not_found',
      incident_id: incidentId,
      status: 'not_found'
    };
  }

  // 3. Process action timeline
  let actionTimeline = [];
  if (actionsResult.status === 'fulfilled' && actionsResult.value.values.length > 0) {
    const { columns, values } = actionsResult.value;
    const colIdx = buildColIndex(columns, [
      '@timestamp', 'action_id', 'agent_name', 'action_type', 'action_detail',
      'target_system', 'target_asset', 'approval_required', 'approved_by',
      'status', 'duration_ms', 'workflow_id', 'result_summary', 'rollback_available'
    ], 'incident-actions');
    actionTimeline = values.map(row => rowToObject(row, colIdx));
  }

  // 4. Process retrospective
  let retroData = {};
  if (retroResult.status === 'fulfilled' && retroResult.value.values.length > 0) {
    const { columns, values } = retroResult.value;
    const colIdx = buildColIndex(columns, [
      'summary', 'data.timeline', 'data.agent_performance',
      'data.improvement_recommendations', 'confidence'
    ], 'incident-retro');
    retroData = rowToObject(values[0], colIdx);
  }

  // 5. Generate narratives in parallel
  const [overviewNarr, timelineNarr, retroNarr] = await Promise.allSettled([
    generateNarrative('incident_overview', incidentData),
    generateNarrative('action_timeline', { actions: actionTimeline }),
    generateNarrative('analyst_retrospective', retroData)
  ]);

  // 6. Determine time window from incident data
  const windowStart = incidentData.created_at || new Date().toISOString();
  const windowEnd = incidentData.resolved_at || new Date().toISOString();

  // 7. Assemble sections
  const sections = [
    {
      section_id: 'incident-overview',
      title: 'Incident Overview',
      narrative: overviewNarr.status === 'fulfilled' ? overviewNarr.value : 'See data.',
      data: {
        incident_id: incidentData.incident_id,
        status: incidentData.status,
        severity: incidentData.severity,
        incident_type: incidentData.incident_type,
        priority_score: incidentData.priority_score,
        created_at: incidentData.created_at,
        resolved_at: incidentData.resolved_at,
        total_duration_seconds: incidentData.total_duration_seconds,
        ttd_seconds: incidentData.ttd_seconds,
        tti_seconds: incidentData.tti_seconds,
        ttr_seconds: incidentData.ttr_seconds,
        ttv_seconds: incidentData.ttv_seconds,
        agents_involved: incidentData.agents_involved,
        reflection_count: incidentData.reflection_count,
        resolution_type: incidentData.resolution_type,
        affected_assets: incidentData.affected_assets,
        investigation: incidentData.investigation,
        remediation_plan: incidentData.remediation_plan,
        verification_results: incidentData.verification_results
      },
      source_query: `FROM vigil-incidents | WHERE incident_id == "${incidentId}" | KEEP incident_id, status, severity, ...`,
      compliance_controls: []
    },
    {
      section_id: 'action-timeline',
      title: 'Action Timeline',
      narrative: timelineNarr.status === 'fulfilled' ? timelineNarr.value : 'See action timeline data.',
      data: { actions: actionTimeline },
      source_query: `FROM vigil-actions-* | WHERE incident_id == "${incidentId}" | SORT @timestamp ASC`,
      compliance_controls: ['SOC2-CC7.3', 'ISO27001-A.5.26']
    },
    {
      section_id: 'analyst-retrospective',
      title: 'Analyst Retrospective',
      narrative: retroNarr.status === 'fulfilled' ? retroNarr.value : 'No retrospective available.',
      data: {
        summary: retroData.summary || null,
        timeline: retroData['data.timeline'] || null,
        agent_performance: retroData['data.agent_performance'] || null,
        improvement_recommendations: retroData['data.improvement_recommendations'] || null,
        confidence: retroData.confidence || null
      },
      source_query: `FROM vigil-learnings | WHERE learning_type == "retrospective" AND incident_ids == "${incidentId}"`,
      compliance_controls: ['ISO27001-A.5.27']
    }
  ];

  // 8. Build report
  const reportId = generateReportId('INC', windowEnd, 'on_demand', incidentId);
  const report = buildReportEnvelope({
    reportId,
    reportType: 'incident_detail',
    title: `Incident Detail Export — ${incidentId}`,
    windowStart,
    windowEnd,
    triggerType: 'on_demand',
    sections,
    metadata: {
      incident_count: 1,
      data_sources: ['vigil-incidents', 'vigil-actions-*', 'vigil-learnings'],
      methodology: `Full incident record retrieved by incident_id. Action timeline sorted chronologically from vigil-actions-*. Analyst retrospective from vigil-learnings where learning_type == "retrospective" and incident_ids contains the target incident.`,
      token_estimate: 3000
    }
  });

  // 9. Index and deliver
  try { await indexReport(report); } catch (err) { log.error(`Failed to index incident detail: ${err.message}`); }
  try { await deliverReport(report); } catch (err) { log.error(`Failed to deliver incident detail: ${err.message}`); }

  const elapsed = Date.now() - startTime;
  log.info(`Incident detail export generated: ${reportId}`, { incidentId, elapsed_ms: elapsed });

  return report;
  }, options);
}
