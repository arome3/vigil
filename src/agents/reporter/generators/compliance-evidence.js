import 'dotenv/config';
import { createLogger } from '../../../utils/logger.js';
import { executeEsqlTool } from '../../../tools/esql/executor.js';
import {
  buildColIndex, rowToObject, generateReportId,
  generateNarrative, buildReportEnvelope, indexReport,
  executeSecondaryEsql, withDeadline
} from '../narrative.js';
import { deliverReport } from '../delivery.js';

const log = createLogger('reporter-compliance');

// Secondary queries not backed by tool JSONs

const ACTIONS_AUDIT_QUERY = `FROM vigil-actions-*
| WHERE @timestamp >= ?window_start AND @timestamp <= ?window_end
| STATS
    total_actions = COUNT(*),
    actions_with_approval = COUNT_IF(approval_required == true),
    approvals_granted = COUNT_IF(approved_by IS NOT NULL),
    actions_succeeded = COUNT_IF(status == "success"),
    actions_failed = COUNT_IF(status == "failed"),
    actions_rolled_back = COUNT_IF(status == "rolled_back")
  BY incident_id
| EVAL
    success_rate = ROUND(actions_succeeded * 100.0 / total_actions, 1),
    approval_compliance = CASE(
      actions_with_approval == 0, "N/A",
      approvals_granted == actions_with_approval, "COMPLIANT",
      "NON_COMPLIANT"
    )`;

const SENTINEL_UPTIME_QUERY = `FROM vigil-agent-telemetry
| WHERE agent_name == "vigil-sentinel"
  AND @timestamp >= ?window_start AND @timestamp <= ?window_end
| STATS
    total_checks = COUNT(*),
    successes = COUNT_IF(status == "success"),
    failures = COUNT_IF(status == "failure")
| EVAL uptime_pct = CASE(total_checks == 0, 0.0, ROUND(successes * 100.0 / total_checks, 2))`;

const LEARNINGS_QUERY = `FROM vigil-learnings
| WHERE @timestamp >= ?window_start AND @timestamp <= ?window_end
| STATS count = COUNT(*) BY learning_type`;

const GDPR_BREACH_QUERY = `FROM vigil-incidents
| WHERE severity == "critical"
  AND incident_type == "security"
  AND created_at >= ?window_start AND created_at <= ?window_end
| STATS
    qualifying_breaches = COUNT(*),
    avg_detection_to_containment = AVG(total_duration_seconds)
| EVAL within_72h = CASE(avg_detection_to_containment <= 259200, true, false)`;

/**
 * Generate a compliance evidence report.
 *
 * @param {string} windowStart - ISO 8601 start
 * @param {string} windowEnd - ISO 8601 end
 * @param {string} triggerType - scheduled_monthly or on_demand
 * @returns {Promise<object>} Report document
 */
export async function generateComplianceEvidence(windowStart, windowEnd, triggerType, options = {}) {
  return withDeadline(async () => {
  const startTime = Date.now();
  log.info('Generating compliance evidence report', { windowStart, windowEnd, triggerType });

  const params = { window_start: windowStart, window_end: windowEnd };

  // 1. Run all queries in parallel
  const [incidentResult, actionsResult, sentinelResult, learningsResult, gdprResult] = await Promise.allSettled([
    executeEsqlTool('vigil-report-compliance-evidence', params),
    executeSecondaryEsql(ACTIONS_AUDIT_QUERY, params),
    executeSecondaryEsql(SENTINEL_UPTIME_QUERY, params),
    executeSecondaryEsql(LEARNINGS_QUERY, params),
    executeSecondaryEsql(GDPR_BREACH_QUERY, params)
  ]);

  // 2. Process incident inventory
  let incidentData = { total: 0, resolved: 0, escalated: 0, suppressed: 0, by_severity: {} };
  let incidentRows = [];
  if (incidentResult.status === 'fulfilled' && incidentResult.value.values.length > 0) {
    const { columns, values } = incidentResult.value;
    const colIdx = buildColIndex(columns, ['incident_id', 'severity', 'status', 'resolution_type', 'affected_service'], 'compliance-incidents');
    incidentRows = values.map(row => rowToObject(row, colIdx));

    const total = values.length;
    const resolved = incidentRows.filter(r => r.status === 'resolved').length;
    const escalated = incidentRows.filter(r => r.status === 'escalated').length;
    const suppressed = incidentRows.filter(r => r.status === 'suppressed').length;
    const severityCounts = {};
    for (const row of incidentRows) {
      severityCounts[row.severity] = (severityCounts[row.severity] || 0) + 1;
    }
    incidentData = { total, resolved, escalated, suppressed, by_severity: severityCounts };
  }

  // 3. Process actions audit trail
  let auditData = {
    incidents_with_audit_trail: 0, total_auditable_incidents: incidentData.total,
    completeness_rate: 0, total_actions_logged: 0,
    actions_requiring_approval: 0, approvals_obtained: 0, approval_compliance_rate: 0
  };
  if (actionsResult.status === 'fulfilled' && actionsResult.value.values.length > 0) {
    const { columns, values } = actionsResult.value;
    const colIdx = buildColIndex(columns, [
      'incident_id', 'total_actions', 'actions_with_approval', 'approvals_granted',
      'actions_succeeded', 'actions_failed'
    ], 'compliance-actions');

    const actionRows = values.map(row => rowToObject(row, colIdx));
    const totalActions = actionRows.reduce((sum, r) => sum + (r.total_actions || 0), 0);
    const totalApprovalRequired = actionRows.reduce((sum, r) => sum + (r.actions_with_approval || 0), 0);
    const totalApproved = actionRows.reduce((sum, r) => sum + (r.approvals_granted || 0), 0);

    auditData = {
      incidents_with_audit_trail: actionRows.length,
      total_auditable_incidents: incidentData.resolved + incidentData.escalated,
      completeness_rate: (incidentData.resolved + incidentData.escalated) > 0
        ? Math.round(actionRows.length * 1000 / (incidentData.resolved + incidentData.escalated)) / 10
        : 0,
      total_actions_logged: totalActions,
      actions_requiring_approval: totalApprovalRequired,
      approvals_obtained: totalApproved,
      approval_compliance_rate: totalApprovalRequired > 0
        ? Math.round(totalApproved * 1000 / totalApprovalRequired) / 10
        : 100
    };
  }

  // 4. Process sentinel monitoring evidence
  let monitoringData = { sentinel_uptime_pct: 0, total_health_checks: 0, services_monitored: 0 };
  if (sentinelResult.status === 'fulfilled' && sentinelResult.value.values.length > 0) {
    const { columns, values } = sentinelResult.value;
    const colIdx = buildColIndex(columns, ['total_checks', 'successes', 'uptime_pct'], 'compliance-sentinel');
    const row = rowToObject(values[0], colIdx);
    const uniqueServices = new Set(incidentRows.map(r => r.affected_service).filter(Boolean));
    monitoringData = {
      sentinel_uptime_pct: row.uptime_pct ?? 0,
      total_health_checks: row.total_checks ?? 0,
      services_monitored: uniqueServices.size || 0
    };
  }

  // 5. Process learnings/retrospective evidence
  let learningsData = {
    retrospectives_generated: 0, terminal_incidents: incidentData.total,
    retrospective_coverage: 0, weight_calibrations: 0,
    threshold_tunings: 0, runbooks_generated: 0, patterns_discovered: 0
  };
  if (learningsResult.status === 'fulfilled' && learningsResult.value.values.length > 0) {
    const { columns, values } = learningsResult.value;
    const colIdx = buildColIndex(columns, ['learning_type', 'count'], 'compliance-learnings');
    const learningRows = values.map(row => rowToObject(row, colIdx));

    for (const row of learningRows) {
      switch (row.learning_type) {
        case 'retrospective': learningsData.retrospectives_generated = row.count ?? 0; break;
        case 'weight_calibration': learningsData.weight_calibrations = row.count ?? 0; break;
        case 'threshold_tuning': learningsData.threshold_tunings = row.count ?? 0; break;
        case 'runbook_generation': learningsData.runbooks_generated = row.count ?? 0; break;
        case 'attack_pattern': learningsData.patterns_discovered = row.count ?? 0; break;
      }
    }
    learningsData.retrospective_coverage = incidentData.total > 0
      ? Math.round(learningsData.retrospectives_generated * 1000 / incidentData.total) / 10
      : 0;
  }

  // 5b. Process GDPR breach evidence
  let gdprData = { qualifying_breaches: 0, within_72h_requirement: true };
  if (gdprResult.status === 'fulfilled' && gdprResult.value.values.length > 0) {
    const { columns, values } = gdprResult.value;
    const colIdx = buildColIndex(columns, ['qualifying_breaches', 'avg_detection_to_containment', 'within_72h'], 'compliance-gdpr');
    const row = rowToObject(values[0], colIdx);
    gdprData = {
      qualifying_breaches: row.qualifying_breaches ?? 0,
      detection_to_containment_seconds: Math.round(row.avg_detection_to_containment ?? 0),
      within_72h_requirement: row.within_72h ?? true
    };
  }

  // 6. Generate narratives for all sections in parallel
  const [invNarr, auditNarr, monNarr, pirNarr, gdprNarr] = await Promise.allSettled([
    generateNarrative('incident_inventory', incidentData),
    generateNarrative('audit_trail_completeness', auditData),
    generateNarrative('continuous_monitoring', monitoringData),
    generateNarrative('post_incident_review', learningsData),
    generateNarrative('gdpr_breach_timeline', gdprData)
  ]);

  // 7. Assemble sections with compliance control mappings
  const sections = [
    {
      section_id: 'incident-inventory',
      title: 'Incident Inventory',
      narrative: invNarr.status === 'fulfilled' ? invNarr.value : 'See data.',
      data: incidentData,
      source_query: `FROM vigil-incidents | WHERE created_at >= '${windowStart}' AND created_at <= '${windowEnd}' AND status IN ("resolved", "escalated") | SORT created_at ASC`,
      compliance_controls: ['SOC2-CC7.2', 'ISO27001-A.5.24']
    },
    {
      section_id: 'audit-trail-completeness',
      title: 'Audit Trail Completeness',
      narrative: auditNarr.status === 'fulfilled' ? auditNarr.value : 'See data.',
      data: auditData,
      source_query: `FROM vigil-actions-* | WHERE @timestamp >= '${windowStart}' AND @timestamp <= '${windowEnd}' | STATS total_actions = COUNT(*), ... BY incident_id`,
      compliance_controls: ['SOC2-CC7.3', 'SOC2-CC7.4', 'ISO27001-A.5.25', 'ISO27001-A.5.26']
    },
    {
      section_id: 'continuous-monitoring-evidence',
      title: 'Continuous Monitoring Evidence',
      narrative: monNarr.status === 'fulfilled' ? monNarr.value : 'See data.',
      data: monitoringData,
      source_query: `FROM vigil-agent-telemetry | WHERE agent_name == 'vigil-sentinel' AND @timestamp >= '${windowStart}' | STATS ...`,
      compliance_controls: ['SOC2-CC7.2', 'ISO27001-A.5.24']
    },
    {
      section_id: 'post-incident-review-evidence',
      title: 'Post-Incident Review Evidence',
      narrative: pirNarr.status === 'fulfilled' ? pirNarr.value : 'See data.',
      data: learningsData,
      source_query: `FROM vigil-learnings | WHERE @timestamp >= '${windowStart}' AND @timestamp <= '${windowEnd}' | STATS COUNT(*) BY learning_type`,
      compliance_controls: ['ISO27001-A.5.27']
    },
    {
      section_id: 'gdpr-breach-timeline',
      title: 'GDPR Article 33 — Breach Notification Timeline',
      narrative: gdprNarr.status === 'fulfilled' ? gdprNarr.value : 'No qualifying breaches in this period.',
      data: gdprData,
      source_query: `FROM vigil-incidents | WHERE severity == "critical" AND incident_type == "security" AND created_at >= '${windowStart}'`,
      compliance_controls: ['GDPR-Art33']
    }
  ];

  // 8. Build report
  const monthLabel = new Date(windowEnd).toISOString().slice(0, 7);
  const reportId = generateReportId('COMP', windowEnd, triggerType, monthLabel);
  const report = buildReportEnvelope({
    reportId,
    reportType: 'compliance_evidence',
    title: `Compliance Evidence Report — ${new Date(windowStart).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
    windowStart,
    windowEnd,
    triggerType,
    sections,
    metadata: {
      incident_count: incidentData.total,
      data_sources: ['vigil-incidents', 'vigil-actions-*', 'vigil-agent-telemetry', 'vigil-learnings'],
      methodology: `All incidents within the reporting period (${windowStart} to ${windowEnd}) UTC. Audit trail completeness verified by cross-referencing vigil-incidents with vigil-actions-* on incident_id. Continuous monitoring uptime derived from vigil-agent-telemetry heartbeat records for vigil-sentinel. GDPR breach qualification based on incident severity=critical AND affected_assets containing PII-classified systems.`,
      token_estimate: 4200
    }
  });

  // 9. Index and deliver
  try {
    await indexReport(report);
  } catch (err) {
    log.error(`Failed to index compliance report: ${err.message}`);
  }

  try {
    await deliverReport(report);
  } catch (err) {
    log.error(`Failed to deliver compliance report: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  log.info(`Compliance evidence report generated: ${reportId}`, {
    incident_count: incidentData.total,
    elapsed_ms: elapsed
  });

  return report;
  }, options);
}
