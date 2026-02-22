import { v4 as uuidv4 } from 'uuid';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { executeEsqlTool } from '../../tools/esql/executor.js';
import { requireColIndex } from '../../utils/esql-helpers.js';
import { embedSafe } from '../../utils/embed-helpers.js';
import { parseDuration } from '../../utils/duration.js';
import {
  F1_THRESHOLD, MIN_SAMPLE_SIZE, DEFAULT_WEIGHTS,
  FP_BIAS_HIGH, FP_BIAS_LOW
} from './constants.js';

const log = createLogger('analyst:weight-calibrator');

/**
 * Fetch the most recently applied production weights from vigil-learnings.
 * Returns null if none found (use DEFAULT_WEIGHTS as fallback).
 */
async function getCurrentWeights() {
  try {
    const result = await client.search({
      index: 'vigil-learnings',
      query: { bool: { must: [
        { term: { learning_type: 'weight_calibration' } },
        { term: { applied: true } }
      ] } },
      sort: [{ applied_at: { order: 'desc' } }],
      size: 1,
      _source: ['data.proposed_weights'],
      timeout: '30s'
    });
    const hit = result.hits.hits[0];
    return hit?._source?.data?.proposed_weights ?? null;
  } catch { return null; }
}

/**
 * Run triage weight calibration analysis.
 *
 * Computes confusion matrix from triage predictions vs actual outcomes,
 * calculates F1 score, and proposes weight adjustments when accuracy
 * drops below threshold.
 *
 * @param {object} options
 * @param {string} [options.window='30d'] - Lookback window
 * @returns {Promise<object|null>} Learning record written, or null if skipped
 */
export async function runWeightCalibration({ window = '30d' } = {}) {
  log.info(`Starting weight calibration (window: ${window})`);

  const { columns, values } = await executeEsqlTool(
    'vigil-esql-triage-calibration',
    { window }
  );

  if (!values || values.length === 0) {
    log.info('No triage calibration data returned — skipping');
    return null;
  }

  const idx = requireColIndex(columns, [
    'total', 'correct',
    'tp_count', 'fp_count_binary', 'fn_count_binary', 'tn_count',
    'accuracy', 'fn_rate', 'fp_rate'
  ], [
    'avg_score_resolved', 'avg_score_escalated', 'avg_score_suppressed'
  ], 'triage-calibration');

  // Single aggregation row (no GROUP BY)
  const row = values[0];
  const total = row[idx.total] || 0;
  const correct = row[idx.correct] || 0;

  // Enforce minimum sample size
  if (total < MIN_SAMPLE_SIZE) {
    log.info(
      `Insufficient data for weight calibration: ${total} incidents (need ${MIN_SAMPLE_SIZE}). Skipping.`
    );
    return null;
  }

  // Read binary confusion matrix counters directly from ES|QL
  const truePositives = row[idx.tp_count] || 0;
  const falsePositives = row[idx.fp_count_binary] || 0;
  const falseNegatives = row[idx.fn_count_binary] || 0;
  const trueNegatives = row[idx.tn_count] || 0;

  // F1 = 2*TP / (2*TP + FP + FN)
  const f1Denominator = 2 * truePositives + falsePositives + falseNegatives;
  const f1 = f1Denominator > 0 ? (2 * truePositives) / f1Denominator : 0;

  log.info(
    `Calibration metrics — Total: ${total}, Accuracy: ${(correct / total * 100).toFixed(1)}%, ` +
    `F1: ${f1.toFixed(3)}, TP: ${truePositives}, TN: ${trueNegatives}, FP: ${falsePositives}, FN: ${falseNegatives}`
  );

  // Only propose changes when F1 drops below threshold
  if (f1 >= F1_THRESHOLD) {
    log.info(`F1 score ${f1.toFixed(3)} >= ${F1_THRESHOLD} — no calibration needed`);
    return null;
  }

  // Determine error direction from FP/FN balance
  // +1 prevents divide-by-zero when both FP and FN are zero. Not a smoothing term.
  const fpBias = falsePositives / (falsePositives + falseNegatives + 1);

  // FP-heavy → we're too aggressive → reduce severity weight, increase fp_rate_inverse
  // FN-heavy → we're missing real threats → increase severity + asset_criticality
  const adjustments = {
    severity:          fpBias > FP_BIAS_HIGH ? -0.05 : fpBias < FP_BIAS_LOW ? +0.05 : 0,
    asset_criticality: fpBias > FP_BIAS_HIGH ? -0.03 : fpBias < FP_BIAS_LOW ? +0.05 : 0,
    corroboration:     fpBias > FP_BIAS_HIGH ? +0.03 : fpBias < FP_BIAS_LOW ? -0.02 : 0,
    fp_rate_inverse:   fpBias > FP_BIAS_HIGH ? +0.05 : fpBias < FP_BIAS_LOW ? -0.03 : 0,
  };

  // Balanced case: all adjustments are zero — no change needed
  const allZero = Object.values(adjustments).every(v => v === 0);
  if (allZero) {
    log.info('F1 below threshold but error direction balanced — no adjustment needed');
    return null;
  }

  // Use most recently applied production weights as base (fall back to defaults)
  const baseWeights = (await getCurrentWeights()) ?? { ...DEFAULT_WEIGHTS };

  // Apply adjustments with clamping per factor
  const proposedWeights = {};
  for (const [factor, current] of Object.entries(baseWeights)) {
    const raw = current + (adjustments[factor] || 0);
    proposedWeights[factor] = Math.max(0.05, Math.min(0.60, raw));
  }

  // Normalize to sum to 1.0
  const weightSum = Object.values(proposedWeights).reduce((a, b) => a + b, 0);
  for (const factor of Object.keys(proposedWeights)) {
    proposedWeights[factor] = Math.round((proposedWeights[factor] / weightSum) * 100) / 100;
  }

  // Fix rounding drift: adjust the largest weight
  const roundedSum = Object.values(proposedWeights).reduce((a, b) => a + b, 0);
  if (roundedSum !== 1.0) {
    const largestFactor = Object.entries(proposedWeights)
      .sort((a, b) => b[1] - a[1])[0][0];
    proposedWeights[largestFactor] = Math.round(
      (proposedWeights[largestFactor] + (1.0 - roundedSum)) * 100
    ) / 100;
  }

  // Project accuracy improvement (conservative estimate)
  const projectedAccuracy = Math.min(0.95, (correct / total) + (F1_THRESHOLD - f1) * 0.5);

  const now = new Date().toISOString();
  const summary =
    `Triage accuracy at ${(correct / total * 100).toFixed(1)}% over ${window} window (${total} incidents). ` +
    `F1 score ${f1.toFixed(3)} below ${F1_THRESHOLD} threshold. ` +
    `Proposing weight adjustment: severity ${DEFAULT_WEIGHTS.severity}→${proposedWeights.severity}, ` +
    `asset_criticality ${DEFAULT_WEIGHTS.asset_criticality}→${proposedWeights.asset_criticality}, ` +
    `corroboration ${DEFAULT_WEIGHTS.corroboration}→${proposedWeights.corroboration}, ` +
    `fp_rate_inverse ${DEFAULT_WEIGHTS.fp_rate_inverse}→${proposedWeights.fp_rate_inverse}.`;

  // Log-scale confidence: better differentiation by sample size
  const confidence = Math.min(0.95, Math.max(0.5, Math.log10(total) / 3 * f1));

  const vector = await embedSafe(summary, log, 'summary_vector');

  const learningRecord = {
    '@timestamp': now,
    learning_id: `LRN-CAL-${uuidv4().slice(0, 8).toUpperCase()}`,
    learning_type: 'weight_calibration',
    incident_ids: [],
    analysis_window: {
      start: new Date(Date.now() - parseDuration(window)).toISOString(),
      end: now,
      incident_count: total
    },
    summary,
    confidence: Math.round(confidence * 100) / 100,
    data: {
      current_weights: { ...DEFAULT_WEIGHTS },
      proposed_weights: proposedWeights,
      accuracy_current: Math.round((correct / total) * 100) / 100,
      accuracy_projected: Math.round(projectedAccuracy * 100) / 100,
      confusion_matrix: {
        true_positive: truePositives,
        true_negative: trueNegatives,
        false_positive: falsePositives,
        false_negative: falseNegatives
      },
      error_direction: fpBias > FP_BIAS_HIGH ? 'fp_heavy' : fpBias < FP_BIAS_LOW ? 'fn_heavy' : 'balanced',
      f1_score: Math.round(f1 * 1000) / 1000
    },
    applied: false,
    applied_at: null,
    reviewed_by: null,
    review_status: 'pending'
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

  log.info(
    `Weight calibration record written: ${learningRecord.learning_id} ` +
    `(F1: ${f1.toFixed(3)}, confidence: ${learningRecord.confidence})`
  );

  return learningRecord;
}
