// Triage Agent A2A request handler.
// Receives enrich_and_score requests, runs 3 tools in parallel,
// computes priority score, and returns the §8.1 contract response.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { executeSearchTool } from '../../tools/search/executor.js';
import {
  scorePriority,
  determineDisposition,
  generateSuppressionReason
} from '../../scoring/priority.js';
import { validateTriageResponse } from '../../a2a/contracts.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { parseThreshold } from '../../utils/env.js';

const log = createLogger('triage-handler');

const INVESTIGATE_THRESHOLD = parseThreshold('VIGIL_TRIAGE_INVESTIGATE_THRESHOLD', 0.7);
const SUPPRESS_THRESHOLD = parseThreshold('VIGIL_TRIAGE_SUPPRESS_THRESHOLD', 0.4);

// Overall triage deadline — tools individually timeout at 30s, but we cap total wall time.
const TRIAGE_DEADLINE_MS = parseInt(process.env.VIGIL_TRIAGE_DEADLINE_MS, 10) || 5000;

// --- ES|QL Result Extractors ---

/**
 * Build a column-name-to-index map from ES|QL columns and warn about
 * any expected columns that are missing. This catches silent breakage
 * when a tool's query aliases change.
 *
 * @param {Array<{name: string}>} columns - ES|QL column descriptors
 * @param {string[]} expectedCols - Column names the extractor needs
 * @param {string} toolLabel - Tool name for log context
 * @returns {Record<string, number>} Column name → index map
 */
function buildColIndex(columns, expectedCols, toolLabel) {
  const colIndex = {};
  columns.forEach((col, i) => { colIndex[col.name] = i; });

  for (const expected of expectedCols) {
    if (colIndex[expected] === undefined) {
      log.warn(`${toolLabel}: expected column '${expected}' not found in result (columns: ${columns.map(c => c.name).join(', ')})`);
    }
  }
  return colIndex;
}

/**
 * Extract enrichment data from the alert-enrichment ES|QL result.
 *
 * ES|QL returns { columns: [{name, type}], values: [[row1], [row2], ...] }.
 * We need to map column names to values in row[0] (top risk_signal).
 *
 * Column names match the ES|QL query aliases in vigil-esql-alert-enrichment:
 *   event_count, unique_destinations, failed_auths, risk_signal
 *
 * @param {{ columns: Array, values: Array }} esqlResult
 * @returns {{ correlated_event_count: number, unique_destinations: number,
 *             failed_auth_count: number, risk_signal: number }}
 */
function extractEnrichment(esqlResult) {
  const defaults = {
    correlated_event_count: 0,
    unique_destinations: 0,
    failed_auth_count: 0,
    risk_signal: 0
  };

  if (!esqlResult?.values?.length || !esqlResult?.columns?.length) {
    return defaults;
  }

  const colIndex = buildColIndex(
    esqlResult.columns,
    ['event_count', 'unique_destinations', 'failed_auths', 'risk_signal'],
    'alert-enrichment'
  );

  const row = esqlResult.values[0];

  return {
    correlated_event_count: row[colIndex['event_count']] ?? 0,
    unique_destinations: row[colIndex['unique_destinations']] ?? 0,
    failed_auth_count: row[colIndex['failed_auths']] ?? 0,
    risk_signal: row[colIndex['risk_signal']] ?? 0
  };
}

/**
 * Extract the false positive rate from the historical-fp-rate ES|QL result.
 * Coerces to number and clamps to [0, 1] at the extraction boundary.
 *
 * @param {{ columns: Array, values: Array }} esqlResult
 * @returns {number} False positive rate (0.0–1.0), defaults to 0 for first-seen rules
 */
function extractFpRate(esqlResult) {
  if (!esqlResult?.values?.length || !esqlResult?.columns?.length) {
    return 0;
  }

  const colIndex = buildColIndex(
    esqlResult.columns,
    ['fp_rate'],
    'historical-fp-rate'
  );

  const row = esqlResult.values[0];
  const raw = row[colIndex['fp_rate']];
  const num = Number(raw);
  if (Number.isNaN(num)) {
    log.warn(`historical-fp-rate: fp_rate column returned non-numeric value '${raw}', defaulting to 0`);
    return 0;
  }
  return Math.min(Math.max(num, 0), 1);
}

/**
 * Extract asset criticality from the search tool result.
 *
 * @param {{ results: Array, total: number }} searchResult
 * @returns {string} Criticality tier string, defaults to 'tier-3'
 */
function extractAssetCriticality(searchResult) {
  if (!searchResult?.results?.length) {
    return 'tier-3';
  }
  return searchResult.results[0].criticality || 'tier-3';
}

// --- Alert Document Update ---

/**
 * Write triage results back to the alert document in vigil-alerts-*.
 * Uses updateByQuery since alert indices are data streams where the
 * concrete backing index is opaque.
 *
 * This is a non-fatal side effect — failure is logged as a warning.
 *
 * @param {string} alertId - Alert document ID
 * @param {object} triageData - Triage fields to write
 */
async function updateAlertDocument(alertId, triageData) {
  try {
    await client.updateByQuery({
      index: 'vigil-alerts-*',
      body: {
        query: {
          term: { 'alert_id': alertId }
        },
        script: {
          source: `
            ctx._source.triage = params.triage;
            ctx._source.priority_score = params.priority_score;
            ctx._source.disposition = params.disposition;
            ctx._source.triaged_at = params.triaged_at;
          `,
          lang: 'painless',
          params: {
            triage: triageData.enrichment,
            priority_score: triageData.priority_score,
            disposition: triageData.disposition,
            triaged_at: new Date().toISOString()
          }
        }
      },
      refresh: true
    });
    log.info(`Updated alert document ${alertId} with triage results`);
  } catch (err) {
    log.warn(`Failed to update alert document ${alertId}: ${err.message}`);
  }
}

// --- Main Handler ---

/**
 * Handle a triage A2A request.
 *
 * Orchestration flow:
 * 1. Validate request shape (task === 'enrich_and_score', alert.alert_id exists)
 * 2. Execute 3 tools in parallel via Promise.allSettled()
 * 3. Extract results with graceful degradation (defaults on failure)
 * 4. Score and determine disposition
 * 5. Build and self-validate response
 * 6. Update alert document (non-fatal)
 * 7. Return response
 *
 * @param {object} envelope - A2A request envelope
 * @param {string} envelope.task - Must be 'enrich_and_score'
 * @param {object} envelope.alert - Alert data
 * @returns {Promise<object>} Validated triage response matching §8.1 contract
 */
export async function handleTriageRequest(envelope) {
  // 1. Validate request
  if (envelope?.task !== 'enrich_and_score') {
    throw new Error(`Invalid task: expected 'enrich_and_score', got '${envelope?.task}'`);
  }

  const alert = envelope.alert;
  if (!alert?.alert_id) {
    throw new Error('Missing required field: alert.alert_id');
  }

  const startTime = Date.now();
  log.info(`Processing alert ${alert.alert_id} (rule: ${alert.rule_id}, severity: ${alert.severity_original})`);

  // 2. Build tool promises — guard against missing affected_asset_id for search tool
  const toolPromises = [
    executeEsqlTool('vigil-esql-alert-enrichment', {
      source_ip: alert.source_ip,
      username: alert.source_user
    }),
    executeEsqlTool('vigil-esql-historical-fp-rate', {
      rule_id: alert.rule_id
    }),
    alert.affected_asset_id
      ? executeSearchTool('vigil-search-asset-criticality', alert.affected_asset_id)
      : Promise.resolve(null) // No asset ID — will default to tier-3
  ];

  if (!alert.affected_asset_id) {
    log.warn(`Alert ${alert.alert_id}: missing affected_asset_id, defaulting to tier-3 criticality`);
  }

  // Race tool execution against an overall deadline so slow tools
  // can't block the handler beyond the 5-second SLA.
  let deadlineId;
  const deadline = new Promise((_, reject) => {
    deadlineId = setTimeout(() => reject(new Error('Triage deadline exceeded')), TRIAGE_DEADLINE_MS);
  });

  let enrichmentResult, fpRateResult, assetResult;
  try {
    [enrichmentResult, fpRateResult, assetResult] = await Promise.race([
      Promise.allSettled(toolPromises),
      deadline.then(() => { throw new Error('Triage deadline exceeded'); })
    ]);
  } catch (err) {
    // Deadline exceeded — proceed with whatever defaults we have
    log.warn(`Alert ${alert.alert_id}: ${err.message} after ${Date.now() - startTime}ms, scoring with defaults`);
    enrichmentResult = enrichmentResult ?? { status: 'rejected', reason: err };
    fpRateResult = fpRateResult ?? { status: 'rejected', reason: err };
    assetResult = assetResult ?? { status: 'rejected', reason: err };
  } finally {
    clearTimeout(deadlineId);
  }

  // 3. Extract results with graceful degradation
  if (enrichmentResult.status === 'rejected') {
    log.warn(`Alert enrichment failed for ${alert.alert_id}: ${enrichmentResult.reason?.message} (params: source_ip=${alert.source_ip}, username=${alert.source_user})`);
  }
  if (fpRateResult.status === 'rejected') {
    log.warn(`FP rate lookup failed for ${alert.alert_id}: ${fpRateResult.reason?.message} (rule_id=${alert.rule_id})`);
  }
  if (assetResult.status === 'rejected') {
    log.warn(`Asset lookup failed for ${alert.alert_id}: ${assetResult.reason?.message} (asset_id=${alert.affected_asset_id})`);
  }

  const enrichment = extractEnrichment(
    enrichmentResult.status === 'fulfilled' ? enrichmentResult.value : null
  );
  const fpRate = extractFpRate(
    fpRateResult.status === 'fulfilled' ? fpRateResult.value : null
  );
  const assetCriticality = extractAssetCriticality(
    assetResult.status === 'fulfilled' ? assetResult.value : null
  );

  // 4. Compute priority score
  const { priority_score, contributing_factors } = scorePriority({
    severity_original: alert.severity_original,
    risk_signal: enrichment.risk_signal,
    historical_fp_rate: fpRate,
    asset_criticality: assetCriticality
  });

  // 5. Determine disposition
  const disposition = determineDisposition(priority_score, {
    investigate: INVESTIGATE_THRESHOLD,
    suppress: SUPPRESS_THRESHOLD
  });

  // 6. Build suppression reason if applicable
  let suppression_reason = null;
  if (disposition === 'suppress') {
    suppression_reason = generateSuppressionReason(
      {
        severity_original: alert.severity_original,
        asset_criticality: assetCriticality,
        historical_fp_rate: fpRate
      },
      priority_score,
      contributing_factors,
      alert.rule_id
    );
  }

  // 7. Build response matching §8.1 contract
  const response = {
    alert_id: alert.alert_id,
    priority_score,
    disposition,
    enrichment: {
      correlated_event_count: enrichment.correlated_event_count,
      unique_destinations: enrichment.unique_destinations,
      failed_auth_count: enrichment.failed_auth_count,
      risk_signal: enrichment.risk_signal,
      historical_fp_rate: fpRate,
      asset_criticality: assetCriticality
    },
    suppression_reason
  };

  // 8. Self-validate against the contract
  validateTriageResponse(response);

  const elapsed = Date.now() - startTime;
  log.info(
    `Alert ${alert.alert_id}: score=${priority_score}, disposition=${disposition}, elapsed=${elapsed}ms`
  );
  if (elapsed > TRIAGE_DEADLINE_MS) {
    log.warn(`Alert ${alert.alert_id}: triage took ${elapsed}ms, exceeding ${TRIAGE_DEADLINE_MS}ms SLA`);
  }

  // 9. Update alert document — fire-and-forget so we don't block the response.
  // The updateByQuery with refresh:true can take 2-3s on a slow cluster;
  // the caller shouldn't wait for a side-effect write.
  updateAlertDocument(alert.alert_id, response).catch(err => {
    log.warn(`Background alert update failed for ${alert.alert_id}: ${err.message}`);
  });

  return response;
}
