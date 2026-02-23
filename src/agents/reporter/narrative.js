import 'dotenv/config';
import axios from 'axios';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('reporter-narrative');

const KIBANA_URL = process.env.KIBANA_URL;
const LLM_CONNECTOR_ID = process.env.LLM_CONNECTOR_ID;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929';

// ── Column index builder ────────────────────────────────────────

/**
 * Build a column-name → index mapping from ES|QL result columns.
 * Avoids assuming column order.
 *
 * @param {Array<{name: string}>} columns - ES|QL result columns
 * @param {string[]} expectedCols - Expected column names
 * @param {string} toolLabel - Label for warning messages
 * @returns {object} Map of column name → index
 */
export function buildColIndex(columns, expectedCols, toolLabel) {
  const idx = {};
  columns.forEach((col, i) => { idx[col.name] = i; });

  for (const col of expectedCols) {
    if (idx[col] === undefined) {
      log.warn(`${toolLabel}: expected column '${col}' not found in results`);
    }
  }
  return idx;
}

/**
 * Extract a single row of ES|QL values into a named object using the column index.
 *
 * @param {Array} row - Single ES|QL result row
 * @param {object} colIdx - Column index map from buildColIndex
 * @returns {object} Key-value pairs
 */
export function rowToObject(row, colIdx) {
  const obj = {};
  for (const [name, idx] of Object.entries(colIdx)) {
    obj[name] = row[idx];
  }
  return obj;
}

// ── Report ID generation ────────────────────────────────────────

/**
 * Get ISO week number for a date.
 */
export function getWeekNumber(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/**
 * Get day of year for a date.
 */
export function getDayOfYear(date) {
  const d = new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d - start) / 86400000) + 1;
}

/**
 * Generate a deterministic report ID.
 *
 * @param {string} typeCode - EXEC, COMP, OPS, AGENT, INC
 * @param {string|Date} windowEnd - End of reporting window
 * @param {string} triggerType - scheduled_daily, scheduled_weekly, scheduled_monthly, on_demand
 * @param {string} [extra] - Extra suffix (e.g. incident_id for INC reports)
 * @returns {string} Report ID like RPT-EXEC-2026-03-17-W11
 */
export function generateReportId(typeCode, windowEnd, triggerType, extra) {
  const d = new Date(windowEnd);
  const dateStr = d.toISOString().slice(0, 10);

  let sequence;
  if (extra) {
    sequence = extra;
  } else if (triggerType === 'scheduled_daily' || triggerType === 'on_demand') {
    sequence = `D${String(getDayOfYear(d)).padStart(3, '0')}`;
  } else if (triggerType === 'scheduled_weekly') {
    sequence = `W${String(getWeekNumber(d)).padStart(2, '0')}`;
  } else if (triggerType === 'scheduled_monthly') {
    sequence = d.toISOString().slice(0, 7); // YYYY-MM
  } else {
    sequence = `D${String(getDayOfYear(d)).padStart(3, '0')}`;
  }

  return `RPT-${typeCode}-${dateStr}-${sequence}`;
}

// ── Trend computation ───────────────────────────────────────────

/**
 * Compute percentage changes between current and prior period data.
 *
 * @param {object} current - Current period metrics
 * @param {object} prior - Prior period metrics
 * @returns {object} Trend data with _change_pct suffixed keys
 */
export function computeTrends(current, prior) {
  const trends = {};
  const metrics = [
    'total_incidents', 'avg_ttr', 'avg_tti', 'avg_ttd',
    'resolved_count', 'escalated_count', 'suppressed_count',
    'autonomous_rate', 'avg_total_duration'
  ];

  for (const metric of metrics) {
    const cur = current[metric];
    const prev = prior[metric];

    if (prev != null && prev !== 0 && cur != null) {
      trends[`${metric}_change_pct`] = Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
    } else {
      trends[`${metric}_change_pct`] = null;
    }
  }

  // Determine overall direction
  const mttrChange = trends.avg_ttr_change_pct;
  if (mttrChange != null) {
    if (mttrChange < -5) trends.mttr_trend = 'improving';
    else if (mttrChange > 5) trends.mttr_trend = 'degrading';
    else trends.mttr_trend = 'stable';
  } else {
    trends.mttr_trend = 'insufficient_data';
  }

  return trends;
}

// ── Report envelope builder ─────────────────────────────────────

/**
 * Assemble the full report document.
 *
 * @param {object} params - Report parameters
 * @returns {object} Report document ready for indexing
 */
export function buildReportEnvelope({
  reportId, reportType, title, windowStart, windowEnd,
  triggerType, sections, metadata
}) {
  const now = new Date().toISOString();
  return {
    '@timestamp': now,
    report_id: reportId,
    report_type: reportType,
    report_title: title,
    reporting_window: {
      start: windowStart,
      end: windowEnd
    },
    generated_at: now,
    generated_by: 'vigil-reporter',
    trigger_type: triggerType,
    sections,
    metadata,
    delivery: {
      channels: [],
      delivered_at: null,
      delivery_status: 'pending'
    },
    status: 'generated'
  };
}

// ── Deadline racing ─────────────────────────────────────────────

const DEFAULT_GENERATOR_DEADLINE_MS =
  parseInt(process.env.VIGIL_REPORT_GENERATOR_DEADLINE_MS, 10) || 120_000;

/**
 * Race a generator function against a deadline timeout.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [options] - Options
 * @param {number} [options.deadlineMs] - Deadline in ms (default 120s)
 * @returns {Promise<*>} Result of fn()
 */
export async function withDeadline(fn, options = {}) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_GENERATOR_DEADLINE_MS;
  let deadlineHandle;
  try {
    const deadline = new Promise((_, reject) => {
      deadlineHandle = setTimeout(
        () => reject(new Error('Report generation deadline exceeded')),
        deadlineMs
      );
    });
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(deadlineHandle);
  }
}

// ── Report validation ───────────────────────────────────────────

/**
 * Validate a report document before indexing.
 * Throws if required fields are missing or malformed.
 *
 * @param {object} report - Report document
 * @returns {true} If valid
 */
export function validateReport(report) {
  const errors = [];
  if (!report.report_id || typeof report.report_id !== 'string') errors.push('report_id is required (string)');
  if (!report.report_type || typeof report.report_type !== 'string') errors.push('report_type is required (string)');
  if (!Array.isArray(report.sections) || report.sections.length === 0) errors.push('sections must be a non-empty array');
  if (report.sections) {
    for (let i = 0; i < report.sections.length; i++) {
      const s = report.sections[i];
      if (!s.section_id) errors.push(`sections[${i}].section_id is required`);
      if (!s.title) errors.push(`sections[${i}].title is required`);
      if (s.narrative === undefined) errors.push(`sections[${i}].narrative is required`);
      if (s.source_query === undefined) errors.push(`sections[${i}].source_query is required`);
    }
  }
  if (!report.reporting_window?.start || !report.reporting_window?.end) errors.push('reporting_window.start and .end are required');
  if (!report.metadata?.methodology) errors.push('metadata.methodology is required');

  if (errors.length > 0) {
    const msg = `Report validation failed: ${errors.join('; ')}`;
    log.error(msg, { report_id: report.report_id });
    throw new Error(msg);
  }
  return true;
}

// ── Index report ────────────────────────────────────────────────

/**
 * Index a report document to vigil-reports.
 * Uses the report_id as the document ID for idempotency.
 * Validates structure, then retries once on failure with a 1s delay.
 *
 * @param {object} report - Report document
 * @returns {Promise<object>} Indexing result
 */
export async function indexReport(report) {
  validateReport(report);
  try {
    const result = await client.index({
      index: 'vigil-reports',
      id: report.report_id,
      document: report
    });
    log.info(`Indexed report ${report.report_id}`);
    return result;
  } catch (err) {
    log.warn(`First indexing attempt failed for ${report.report_id}: ${err.message}. Retrying in 1s...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const result = await client.index({
        index: 'vigil-reports',
        id: report.report_id,
        document: report
      });
      log.info(`Indexed report ${report.report_id} on retry`);
      return result;
    } catch (retryErr) {
      log.error(`Failed to index report ${report.report_id} after retry: ${retryErr.message}`);
      throw retryErr;
    }
  }
}

// ── Secondary ES|QL executor ────────────────────────────────────

const SECONDARY_TIMEOUT = 30_000;

/**
 * Execute an ad-hoc ES|QL query not backed by a tool JSON file.
 * Used for secondary queries in multi-query report types.
 *
 * @param {string} query - ES|QL query string
 * @param {object} [params] - Query parameters
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=30000] - Query timeout
 * @returns {Promise<{ columns: Array, values: Array, took: number }>}
 */
export async function executeSecondaryEsql(query, params = {}, options = {}) {
  const timeout = options.timeout ?? SECONDARY_TIMEOUT;
  const esqlParams = Object.entries(params).map(([name, value]) => ({ [name]: value }));
  const body = { query };
  if (esqlParams.length > 0) {
    body.params = esqlParams;
  }

  try {
    const response = await client.transport.request(
      { method: 'POST', path: '/_query', body },
      { requestTimeout: timeout, meta: true }
    );

    const result = response.body;
    log.info(
      `Secondary ES|QL: ${(result.values || []).length} rows, took ${result.took ?? 0}ms`
    );
    return {
      columns: result.columns || [],
      values: result.values || [],
      took: result.took ?? 0
    };
  } catch (err) {
    // Retry once on timeout
    if (err.message?.includes('timeout') || err.meta?.statusCode === 408) {
      log.warn('Secondary ES|QL timeout, retrying with extended timeout...');
      try {
        const response = await client.transport.request(
          { method: 'POST', path: '/_query', body },
          { requestTimeout: timeout * 2, meta: true }
        );
        const result = response.body;
        return {
          columns: result.columns || [],
          values: result.values || [],
          took: result.took ?? 0
        };
      } catch (retryErr) {
        log.error(`Secondary ES|QL failed after retry: ${retryErr.message}`);
        throw retryErr;
      }
    }
    const status = err.meta?.statusCode || 'unknown';
    const reason = err.meta?.body?.error?.reason || err.message;
    throw new Error(`Secondary ES|QL failed (status ${status}): ${reason}`);
  }
}

// ── LLM Narrative Generation ────────────────────────────────────

/**
 * Generate a narrative summary using LLM with template fallback.
 *
 * @param {string} sectionType - Section identifier (e.g. 'executive_brief')
 * @param {object} data - Data to summarize
 * @param {object} [options] - Generation options
 * @returns {Promise<string>} Generated narrative
 */
export async function generateNarrative(sectionType, data, options = {}) {
  const prompt = buildNarrativePrompt(sectionType, data);

  // Try LLM generation
  try {
    const narrative = await callLlm(prompt);
    if (narrative) return narrative;
  } catch (err) {
    log.warn(`LLM narrative generation failed for ${sectionType}: ${err.message}. Using template fallback.`);
  }

  // Template fallback
  return generateTemplateFallback(sectionType, data);
}

/**
 * Build a structured prompt for LLM narrative generation.
 */
function buildNarrativePrompt(sectionType, data) {
  const preamble = 'You are generating a report section narrative for a security operations platform. Write a concise, factual summary grounded ONLY in the provided data. Use specific numbers. Do not speculate.';

  const sectionInstructions = {
    executive_brief: 'Write a 3-5 bullet point executive brief a CISO can read in 30 seconds. Include total incidents, autonomous resolution rate, MTTR trend, and any notable incidents.',
    timing_metrics: 'Summarize the response timing metrics, highlighting which phase takes the longest and any notable changes.',
    top_assets: 'Describe the most affected assets, their incident counts, and criticality tiers.',
    incident_inventory: 'Summarize the incident inventory for the reporting period, including counts by status and severity.',
    audit_trail_completeness: 'Describe the audit trail completeness metrics, including action counts and approval compliance.',
    continuous_monitoring: 'Describe the continuous monitoring evidence including Sentinel uptime and health check counts.',
    post_incident_review: 'Summarize the post-incident review evidence including retrospective coverage and learning outputs.',
    gdpr_breach_timeline: 'Describe any GDPR-qualifying breaches and their detection-to-notification timelines.',
    per_service_metrics: 'Summarize per-service operational metrics, highlighting services with the most incidents and their MTTR.',
    deployment_correlation: 'Describe deployment-correlated incidents, including the number of deployment-induced incidents.',
    runbook_utilization: 'Summarize runbook utilization rates and success rates.',
    agent_execution_metrics: 'Describe per-agent execution metrics including timing statistics and success rates.',
    triage_accuracy: 'Summarize triage accuracy metrics from the latest calibration data.',
    verifier_effectiveness: 'Describe verifier effectiveness including first-attempt success rate.',
    incident_overview: 'Provide a comprehensive overview of the incident including timeline, severity, and resolution.',
    action_timeline: 'Describe the chronological action timeline for the incident.',
    analyst_retrospective: 'Summarize the analyst retrospective findings and recommendations.'
  };

  const instruction = sectionInstructions[sectionType] || 'Write a concise factual summary of the provided data.';

  return `${preamble}\n\nSection: ${sectionType}\nInstruction: ${instruction}\n\nData:\n${JSON.stringify(data, null, 2)}`;
}

/**
 * Call LLM via Kibana connector API or direct Anthropic API.
 */
async function callLlm(prompt) {
  // Try Kibana connector first
  if (KIBANA_URL && LLM_CONNECTOR_ID) {
    try {
      const resp = await axios.post(
        `${KIBANA_URL}/api/actions/connector/${LLM_CONNECTOR_ID}/_execute`,
        {
          params: {
            subAction: 'invokeAI',
            subActionParams: {
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.2
            }
          }
        },
        {
          headers: {
            'kbn-xsrf': 'true',
            'Authorization': `ApiKey ${process.env.ELASTIC_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const message = resp.data?.data?.message;
      if (message) return message;
    } catch (err) {
      log.warn(`Kibana connector LLM call failed: ${err.message}`);
    }
  }

  // Try direct Anthropic API
  if (LLM_API_KEY) {
    try {
      const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: LLM_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        },
        {
          headers: {
            'x-api-key': LLM_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const content = resp.data?.content?.[0]?.text;
      if (content) return content;
    } catch (err) {
      log.warn(`Direct LLM API call failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * Generate a template-based narrative fallback when LLM is unavailable.
 */
function generateTemplateFallback(sectionType, data) {
  switch (sectionType) {
    case 'executive_brief': {
      const d = data.current || data;
      const trends = data.trends || {};
      const mttrTrend = trends.mttr_trend || 'stable';
      return `Vigil processed ${d.total_incidents ?? 0} incidents in this reporting window. ` +
        `${d.resolved_count ?? 0} resolved autonomously (${d.autonomous_rate ?? 0}% autonomous rate), ` +
        `${d.escalated_count ?? 0} escalated to human operators, ` +
        `${d.suppressed_count ?? 0} suppressed as false positives. ` +
        `Mean time to remediate: ${Math.round(d.avg_ttr ?? 0)}s. ` +
        `MTTR trend: ${mttrTrend}. ` +
        `${d.total_reflections ?? 0} reflection loops triggered.`;
    }

    case 'timing_metrics': {
      const d = data.current || data;
      return `Detection speed averaged ${Math.round(d.avg_ttd ?? 0)}s. ` +
        `Investigation time averaged ${Math.round(d.avg_tti ?? 0)}s. ` +
        `Remediation execution averaged ${Math.round(d.avg_ttr ?? 0)}s. ` +
        `Verification averaged ${Math.round(d.avg_ttv ?? 0)}s. ` +
        `Total average duration: ${Math.round(d.avg_total_duration ?? 0)}s.`;
    }

    case 'top_assets':
      return 'See data table for most affected assets and their incident counts.';

    case 'incident_inventory': {
      const d = data;
      return `${d.total ?? 0} incidents processed in the reporting period. ` +
        `${d.resolved ?? 0} resolved, ${d.escalated ?? 0} escalated, ${d.suppressed ?? 0} suppressed.`;
    }

    case 'audit_trail_completeness': {
      const d = data;
      return `${d.incidents_with_audit_trail ?? 0} of ${d.total_auditable_incidents ?? 0} auditable incidents ` +
        `have complete action audit trails (${d.completeness_rate ?? 0}% completeness). ` +
        `${d.total_actions_logged ?? 0} total actions logged. ` +
        `${d.actions_requiring_approval ?? 0} actions required approval, ` +
        `${d.approvals_obtained ?? 0} approvals obtained.`;
    }

    case 'continuous_monitoring': {
      const d = data;
      return `Sentinel agent operated with ${d.sentinel_uptime_pct ?? 0}% uptime. ` +
        `${d.total_health_checks ?? 0} health checks executed across ${d.services_monitored ?? 0} services.`;
    }

    case 'post_incident_review': {
      const d = data;
      return `Analyst agent generated retrospectives for ${d.retrospectives_generated ?? 0} of ` +
        `${d.terminal_incidents ?? 0} terminal incidents (${d.retrospective_coverage ?? 0}% coverage). ` +
        `${d.weight_calibrations ?? 0} weight calibrations, ${d.threshold_tunings ?? 0} threshold tunings, ` +
        `${d.runbooks_generated ?? 0} new runbooks produced.`;
    }

    case 'gdpr_breach_timeline': {
      const d = data;
      if (!d.qualifying_breaches || d.qualifying_breaches === 0) {
        return 'No incidents qualified as personal data breaches under GDPR during this period.';
      }
      return `${d.qualifying_breaches} incident(s) qualified as personal data breaches. ` +
        `Detection-to-containment: ${d.detection_to_containment_seconds ?? 0}s. ` +
        `Detection-to-notification: ${d.detection_to_notification_seconds ?? 0}s. ` +
        `Within 72-hour requirement: ${d.within_72h_requirement ? 'Yes' : 'No'}.`;
    }

    case 'per_service_metrics':
      return 'See data table for per-service operational incident metrics.';

    case 'deployment_correlation':
      return 'See data table for deployment-correlated incident analysis.';

    case 'runbook_utilization':
      return 'See data table for runbook utilization rates and success metrics.';

    case 'agent_execution_metrics':
      return 'See data table for per-agent execution timing and success rates.';

    case 'triage_accuracy': {
      const d = data;
      return d.accuracy_current != null
        ? `Current triage accuracy: ${d.accuracy_current}. Confidence: ${d.confidence ?? 'N/A'}.`
        : 'No triage calibration data available for this reporting window.';
    }

    case 'verifier_effectiveness': {
      const d = data;
      return `${d.total_resolved ?? 0} incidents resolved. ` +
        `${d.first_attempt_pass ?? 0} passed on first attempt (${d.first_attempt_rate ?? 0}% first-attempt rate). ` +
        `Average health score: ${d.avg_health_score ?? 'N/A'}.`;
    }

    case 'incident_overview': {
      const d = data;
      return `Incident ${d.incident_id ?? 'unknown'}: ${d.severity ?? 'unknown'} severity ${d.incident_type ?? ''} incident. ` +
        `Status: ${d.status ?? 'unknown'}. Total duration: ${d.total_duration_seconds ?? 0}s.`;
    }

    case 'action_timeline':
      return 'See action timeline data for chronological remediation steps.';

    case 'analyst_retrospective':
      return data.summary || 'No analyst retrospective available for this incident.';

    default:
      return 'Report data available in the structured data field.';
  }
}
