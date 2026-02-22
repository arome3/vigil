import { v4 as uuidv4 } from 'uuid';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { executeEsqlTool } from '../../tools/esql/executor.js';
import { requireColIndex } from '../../utils/esql-helpers.js';
import { embedSafe } from '../../utils/embed-helpers.js';
import { parseDuration } from '../../utils/duration.js';
import {
  MIN_DATA_POINTS, MAX_ADJUSTMENT, FP_RATE_THRESHOLD, ESQL_PERCENTAGE_DIVISOR
} from './constants.js';

const log = createLogger('analyst:threshold-tuner');

/**
 * Batch-fetch current anomaly thresholds for multiple services in a single query.
 * Uses field_collapse on service_name to get the latest threshold per service.
 *
 * @param {string[]} serviceNames - Service names to look up
 * @returns {Promise<Map<string, number>>} Map of service name → threshold value
 */
async function batchGetThresholds(serviceNames) {
  const thresholdMap = new Map();
  if (serviceNames.length === 0) return thresholdMap;

  if (serviceNames.length > 10000) {
    log.warn(`batchGetThresholds: ${serviceNames.length} services exceeds field_collapse safe limit. Results may be incomplete.`);
  }

  try {
    const result = await client.search({
      index: 'vigil-baselines',
      query: {
        bool: {
          must: [
            { terms: { service_name: serviceNames } },
            { term: { metric_name: 'anomaly_threshold' } }
          ]
        }
      },
      collapse: { field: 'service_name' },
      sort: [{ computed_at: { order: 'desc' } }],
      size: serviceNames.length,
      timeout: '30s'
    });

    for (const hit of result.hits.hits) {
      const src = hit._source;
      const value = src?.stddev_value ?? src?.avg_value ?? 2.0;
      thresholdMap.set(src.service_name, value);
    }
  } catch (err) {
    log.warn(`Batch threshold lookup failed: ${err.message}. Using defaults.`);
  }

  // Fill defaults for missing services
  for (const name of serviceNames) {
    if (!thresholdMap.has(name)) {
      thresholdMap.set(name, 2.0);
    }
  }

  return thresholdMap;
}

/**
 * Run per-service threshold tuning analysis.
 *
 * Identifies services with high false positive rates (increase threshold)
 * or missed detections (decrease threshold). Caps adjustments at ±0.5
 * per cycle and requires minimum 10 data points.
 *
 * @param {object} options
 * @param {string} [options.window='14d'] - Lookback window
 * @returns {Promise<object|null>} Learning record written, or null if no changes needed
 */
export async function runThresholdTuning({ window = '14d' } = {}) {
  log.info(`Starting threshold tuning analysis (window: ${window})`);

  const { columns, values } = await executeEsqlTool(
    'vigil-esql-threshold-analysis',
    { window }
  );

  if (!values || values.length === 0) {
    log.info('No threshold analysis data returned — skipping');
    return null;
  }

  const idx = requireColIndex(columns, [
    'affected_service', 'total_detections', 'true_positives',
    'false_positives', 'fp_rate', 'recommended_threshold'
  ], [
    'avg_deviation', 'precision'
  ], 'threshold-analysis');

  // Batch-fetch all thresholds upfront (avoids N+1)
  const serviceNames = values.map(row => row[idx.affected_service]).filter(Boolean);
  const thresholdMap = await batchGetThresholds(serviceNames);

  const perServiceAnalysis = [];
  // Threshold analysis is aggregate per-service — individual incident IDs not available from ES|QL STATS
  const incidentIds = [];

  for (const row of values) {
    const serviceName = row[idx.affected_service];
    const totalDetections = row[idx.total_detections] || 0;
    const truePositives = row[idx.true_positives] || 0;
    const falsePositives = row[idx.false_positives] || 0;
    const fpRate = row[idx.fp_rate] || 0;

    const currentThreshold = thresholdMap.get(serviceName) ?? 2.0;

    // Minimum data points check
    if (totalDetections < MIN_DATA_POINTS) {
      log.info(
        `${serviceName}: ${totalDetections} detections < ${MIN_DATA_POINTS} minimum — skipping`
      );
      perServiceAnalysis.push({
        service_name: serviceName,
        current_threshold: currentThreshold,
        proposed_threshold: currentThreshold,
        direction: 'unchanged',
        reason: `Insufficient data (${totalDetections} detections, need ${MIN_DATA_POINTS})`,
        data_points: totalDetections,
        // fpRate from ES|QL is percentage (40.0). Store as decimal (0.40).
        fp_rate: Math.round(fpRate) / 100
      });
      continue;
    }

    const recommendedThreshold = row[idx.recommended_threshold] ?? currentThreshold;
    let proposedThreshold = currentThreshold;
    let direction = 'unchanged';
    let reason = '';

    if (fpRate > FP_RATE_THRESHOLD) {
      // High FP rate → increase threshold (less sensitive)
      proposedThreshold = Math.min(recommendedThreshold, currentThreshold + MAX_ADJUSTMENT);
      proposedThreshold = Math.round(proposedThreshold * 100) / 100;
      direction = 'increase';
      reason = `FP rate ${fpRate}% exceeds ${FP_RATE_THRESHOLD}% threshold`;
      log.info(`${serviceName}: FP rate ${fpRate}% — proposing threshold ${currentThreshold} → ${proposedThreshold}`);
    } else if (recommendedThreshold !== currentThreshold) {
      // ES|QL recommends a change for other reasons
      const delta = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, recommendedThreshold - currentThreshold));
      proposedThreshold = Math.round((currentThreshold + delta) * 100) / 100;
      direction = delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'unchanged';
      reason = `ES|QL recommended threshold ${recommendedThreshold} (current: ${currentThreshold})`;
      log.info(`${serviceName}: ES|QL recommends ${recommendedThreshold} — proposing threshold ${currentThreshold} → ${proposedThreshold}`);
    } else {
      reason = `Precision ${(truePositives / totalDetections * 100).toFixed(0)}% — well-calibrated`;
      log.info(`${serviceName}: threshold looks good (precision ${(truePositives / totalDetections * 100).toFixed(1)}%)`);
    }

    perServiceAnalysis.push({
      service_name: serviceName,
      current_threshold: currentThreshold,
      proposed_threshold: proposedThreshold,
      direction,
      reason,
      data_points: totalDetections,
      fp_rate: Math.round(fpRate) / ESQL_PERCENTAGE_DIVISOR
    });
  }

  // Check if any changes are proposed
  const changedServices = perServiceAnalysis.filter(s => s.direction !== 'unchanged');
  if (changedServices.length === 0) {
    log.info('No threshold changes needed — all services within acceptable ranges');
    return null;
  }

  const now = new Date().toISOString();
  const totalIncidents = values.reduce((sum, row) => sum + (row[idx.total_detections] || 0), 0);

  // Build summary text
  const changeSummaries = changedServices.map(s =>
    `${s.service_name}: ${s.direction} threshold ${s.current_threshold} → ${s.proposed_threshold} (${s.reason})`
  );
  const summary =
    `Threshold tuning analysis over ${window} window. ` +
    `${changedServices.length} service(s) require adjustment: ${changeSummaries.join('. ')}.`;

  const confidence = Math.min(
    0.95,
    Math.max(0.5, changedServices.reduce((sum, s) => sum + s.data_points, 0) / 100 + 0.4)
  );

  const summaryVector = await embedSafe(summary, log, 'summary_vector');

  const learningRecord = {
    '@timestamp': now,
    learning_id: `LRN-THR-${uuidv4().slice(0, 8).toUpperCase()}`,
    learning_type: 'threshold_tuning',
    incident_ids: incidentIds,
    analysis_window: {
      start: new Date(Date.now() - parseDuration(window, 14 * 24 * 60 * 60 * 1000)).toISOString(),
      end: now,
      incident_count: totalIncidents
    },
    summary,
    confidence: Math.round(confidence * 100) / 100,
    data: {
      per_service_analysis: perServiceAnalysis
    },
    applied: false,
    applied_at: null,
    reviewed_by: null,
    review_status: 'pending'
  };

  if (summaryVector) {
    learningRecord.summary_vector = summaryVector;
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

  log.info(
    `Threshold tuning record written: ${learningRecord.learning_id} ` +
    `(${changedServices.length} changes proposed, confidence: ${learningRecord.confidence})`
  );

  return learningRecord;
}
