import 'dotenv/config';
import { createLogger } from '../../../utils/logger.js';
import { executeEsqlTool } from '../../../tools/esql/executor.js';
import {
  buildColIndex, rowToObject, generateReportId, computeTrends,
  generateNarrative, buildReportEnvelope, indexReport,
  executeSecondaryEsql, getWeekNumber, withDeadline
} from '../narrative.js';
import { deliverReport } from '../delivery.js';

const log = createLogger('reporter-executive-summary');

const TOP_ASSETS_QUERY = `FROM vigil-incidents
| WHERE created_at >= ?window_start AND created_at <= ?window_end
| MV_EXPAND affected_assets.name
| STATS incident_count = COUNT(*) BY asset_name = affected_assets.name
| SORT incident_count DESC
| LIMIT 10`;

/**
 * Generate an executive summary report.
 *
 * Queries the current reporting window and the equivalent prior window,
 * computes trend comparisons, generates LLM narratives with template fallback,
 * and indexes the report to vigil-reports.
 *
 * @param {string} windowStart - ISO 8601 start of reporting window
 * @param {string} windowEnd - ISO 8601 end of reporting window
 * @param {string} triggerType - scheduled_daily, scheduled_weekly, or on_demand
 * @param {object} [options] - Options (e.g. deadlineMs for testable deadline injection)
 * @returns {Promise<object>} Report document
 */
export async function generateExecutiveSummary(windowStart, windowEnd, triggerType, options = {}) {
  return withDeadline(async () => {
  const startTime = Date.now();
  log.info('Generating executive summary', { windowStart, windowEnd, triggerType });

  // 1. Compute prior window (same duration shifted back)
  const windowDurationMs = new Date(windowEnd) - new Date(windowStart);
  const priorEnd = windowStart;
  const priorStart = new Date(new Date(windowStart).getTime() - windowDurationMs).toISOString();

  // 2. Query current, prior, and top assets in parallel
  const [currentResult, priorResult, assetsResult] = await Promise.allSettled([
    executeEsqlTool('vigil-report-executive-summary', {
      window_start: windowStart,
      window_end: windowEnd
    }),
    executeEsqlTool('vigil-report-executive-summary', {
      window_start: priorStart,
      window_end: priorEnd
    }),
    executeSecondaryEsql(TOP_ASSETS_QUERY, { window_start: windowStart, window_end: windowEnd })
  ]);

  // 3. Extract current window data
  let currentData = {};
  let currentSourceQuery = '';
  if (currentResult.status === 'fulfilled' && currentResult.value.values.length > 0) {
    const { columns, values } = currentResult.value;
    const colIdx = buildColIndex(columns, [
      'total_incidents', 'security_incidents', 'operational_incidents',
      'critical_count', 'high_count', 'medium_count', 'low_count',
      'resolved_count', 'escalated_count', 'suppressed_count',
      'avg_ttd', 'avg_tti', 'avg_ttr', 'avg_ttv', 'avg_total_duration',
      'total_reflections', 'first_attempt_resolutions',
      'autonomous_rate', 'suppression_rate', 'first_attempt_rate',
      'avg_ttd_display', 'avg_tti_display', 'avg_ttr_display', 'avg_total_display'
    ], 'executive-summary');
    currentData = rowToObject(values[0], colIdx);
    currentSourceQuery = `FROM vigil-incidents | WHERE created_at >= '${windowStart}' AND created_at <= '${windowEnd}' | STATS total_incidents = COUNT(*), ... | EVAL autonomous_rate = ...`;
  } else {
    log.warn('No data returned for current window executive summary');
  }

  // 4. Extract prior window data
  let priorData = {};
  if (priorResult.status === 'fulfilled' && priorResult.value.values.length > 0) {
    const { columns, values } = priorResult.value;
    const colIdx = buildColIndex(columns, ['total_incidents', 'avg_ttr', 'resolved_count'], 'executive-summary-prior');
    priorData = rowToObject(values[0], colIdx);
  } else {
    log.warn('No prior window data available for trend comparison');
  }

  // 4b. Extract top assets data
  let topAssets = [];
  if (assetsResult.status === 'fulfilled' && assetsResult.value.values.length > 0) {
    const { columns, values } = assetsResult.value;
    const colIdx = buildColIndex(columns, ['asset_name', 'incident_count'], 'exec-top-assets');
    topAssets = values.map(row => rowToObject(row, colIdx));
  }

  // 5. Compute trends
  const trends = computeTrends(currentData, priorData);

  // 6. Generate narratives
  const [execBriefNarrative, timingNarrative, assetsNarrative] = await Promise.allSettled([
    generateNarrative('executive_brief', { current: currentData, prior: priorData, trends }),
    generateNarrative('timing_metrics', { current: currentData }),
    generateNarrative('top_assets', { assets: topAssets })
  ]);

  // 7. Assemble sections
  const sections = [
    {
      section_id: 'exec-brief',
      title: 'Executive Brief',
      narrative: execBriefNarrative.status === 'fulfilled' ? execBriefNarrative.value : 'Executive summary data available in structured format.',
      data: {
        total_incidents: currentData.total_incidents ?? 0,
        security: currentData.security_incidents ?? 0,
        operational: currentData.operational_incidents ?? 0,
        by_severity: {
          critical: currentData.critical_count ?? 0,
          high: currentData.high_count ?? 0,
          medium: currentData.medium_count ?? 0,
          low: currentData.low_count ?? 0
        },
        resolved: currentData.resolved_count ?? 0,
        escalated: currentData.escalated_count ?? 0,
        suppressed: currentData.suppressed_count ?? 0,
        autonomous_rate: currentData.autonomous_rate ?? 0,
        suppression_rate: currentData.suppression_rate ?? 0,
        avg_mttr_seconds: Math.round(currentData.avg_ttr ?? 0),
        prev_window_mttr_seconds: Math.round(priorData.avg_ttr ?? 0),
        mttr_change_pct: trends.avg_ttr_change_pct,
        reflection_loops: currentData.total_reflections ?? 0
      },
      source_query: currentSourceQuery,
      compliance_controls: []
    },
    {
      section_id: 'timing-metrics',
      title: 'Response Timing Metrics',
      narrative: timingNarrative.status === 'fulfilled' ? timingNarrative.value : 'Timing data available in structured format.',
      data: {
        avg_ttd_seconds: Math.round(currentData.avg_ttd ?? 0),
        avg_tti_seconds: Math.round(currentData.avg_tti ?? 0),
        avg_ttr_seconds: Math.round(currentData.avg_ttr ?? 0),
        avg_ttv_seconds: Math.round(currentData.avg_ttv ?? 0),
        avg_total_seconds: Math.round(currentData.avg_total_duration ?? 0)
      },
      source_query: `FROM vigil-incidents | WHERE created_at >= '${windowStart}' AND created_at <= '${windowEnd}' | STATS AVG(ttd_seconds), AVG(tti_seconds), AVG(ttr_seconds), AVG(ttv_seconds), AVG(total_duration_seconds)`,
      compliance_controls: []
    },
    {
      section_id: 'top-assets',
      title: 'Most Affected Assets',
      narrative: assetsNarrative.status === 'fulfilled' ? assetsNarrative.value : 'Asset data available in structured format.',
      data: {
        top_assets: topAssets
      },
      source_query: `FROM vigil-incidents | WHERE created_at >= '${windowStart}' AND created_at <= '${windowEnd}' | MV_EXPAND affected_assets.name | STATS incident_count = COUNT(*) BY affected_assets.name | SORT incident_count DESC | LIMIT 10`,
      compliance_controls: []
    }
  ];

  // 8. Build report title
  const periodLabel = triggerType === 'scheduled_weekly' || windowDurationMs >= 6 * 86400000
    ? `Weekly Security Operations Summary — Week ${String(getWeekNumber(windowEnd)).padStart(2, '0')}`
    : `Daily Security Operations Summary — ${new Date(windowEnd).toISOString().slice(0, 10)}`;

  // 9. Build report envelope
  const reportId = generateReportId('EXEC', windowEnd, triggerType);
  const report = buildReportEnvelope({
    reportId,
    reportType: 'executive_summary',
    title: periodLabel,
    windowStart,
    windowEnd,
    triggerType,
    sections,
    metadata: {
      incident_count: currentData.total_incidents ?? 0,
      data_sources: ['vigil-incidents'],
      methodology: `Aggregated all incidents within the reporting window (${windowStart} to ${windowEnd}). Timing metrics computed from non-null TTD/TTI/TTR/TTV fields on resolved incidents only. Trend comparison uses the identical query against the prior window of equal duration.`,
      token_estimate: 2400
    }
  });

  // 10. Index and deliver
  try {
    await indexReport(report);
  } catch (err) {
    log.error(`Failed to index executive summary: ${err.message}`);
  }

  try {
    await deliverReport(report);
  } catch (err) {
    log.error(`Failed to deliver executive summary: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  log.info(`Executive summary generated: ${reportId}`, {
    incident_count: currentData.total_incidents ?? 0,
    elapsed_ms: elapsed
  });

  return report;
  }, options);
}
