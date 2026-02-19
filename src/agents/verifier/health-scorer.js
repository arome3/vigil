// Health score computation — pure functions, no async, no I/O.
// Evaluates individual success criteria against live health data
// and computes the aggregate health score (passed / total ratio).
//
// Implements DUAL COMPARISON: each criterion must pass both
// (a) the Commander's success threshold AND (b) the ES|QL baseline
// verdict column (when available). This prevents false positives
// where a service meets the threshold but is still degraded vs baseline.

import { createLogger } from '../../utils/logger.js';

const log = createLogger('verifier-scorer');

/**
 * Map from criterion metric names to healthData field names.
 * latency_p95 falls back to avg_latency as a proxy.
 */
const METRIC_FIELD_MAP = {
  error_rate: 'error_rate',
  avg_latency: 'avg_latency',
  throughput: 'throughput',
  cpu: 'cpu',
  memory: 'memory',
  latency_p95: 'avg_latency'
};

/**
 * Map from criterion metric names to the ES|QL boolean verdict column
 * that represents the baseline comparison result. Metrics without a
 * corresponding verdict column (cpu, memory) skip baseline checking.
 */
const BASELINE_VERDICT_MAP = {
  avg_latency: 'latency_within_baseline',
  latency_p95: 'latency_within_baseline',
  error_rate: 'error_rate_acceptable',
  throughput: 'throughput_recovered'
};

/** Epsilon for floating-point equality comparison. */
const FLOAT_EPSILON = 1e-9;

/**
 * Operator evaluation functions.
 */
const OPERATORS = {
  lte: (current, threshold) => current <= threshold,
  gte: (current, threshold) => current >= threshold,
  eq: (current, threshold) => Math.abs(current - threshold) < FLOAT_EPSILON
};

/**
 * Evaluate a single success criterion against live health data.
 * Uses DUAL COMPARISON: the criterion passes only if BOTH the
 * Commander's threshold check AND the baseline verdict pass.
 *
 * @param {{ metric: string, operator: string, threshold: number }} criterion
 * @param {{ avg_latency: number|null, error_rate: number|null, throughput: number|null, cpu: number|null, memory: number|null, latency_within_baseline: boolean|null, error_rate_acceptable: boolean|null, throughput_recovered: boolean|null }|null} healthData
 * @returns {{ metric: string, current_value: number|null, threshold: number, passed: boolean }}
 */
export function evaluateCriterion(criterion, healthData) {
  const fieldName = METRIC_FIELD_MAP[criterion.metric] || criterion.metric;

  if (!healthData || healthData[fieldName] === null || healthData[fieldName] === undefined) {
    log.warn(`No health data for metric '${criterion.metric}' — marking as failed`);
    return {
      metric: criterion.metric,
      current_value: null,
      threshold: criterion.threshold,
      passed: false
    };
  }

  const currentValue = healthData[fieldName];
  const evaluate = OPERATORS[criterion.operator];
  const thresholdPassed = evaluate(currentValue, criterion.threshold);

  // Dual comparison: also check baseline verdict when available.
  // If no baseline verdict column exists for this metric (e.g. cpu, memory),
  // or the column was null (ES|QL returned no data), skip baseline check.
  const baselineVerdictField = BASELINE_VERDICT_MAP[criterion.metric];
  const baselineVerdictValue = baselineVerdictField
    ? healthData[baselineVerdictField]
    : null;
  const baselinePassed = baselineVerdictValue === null || baselineVerdictValue === true;

  const passed = thresholdPassed && baselinePassed;

  if (thresholdPassed && !baselinePassed) {
    log.warn(
      `Criterion ${criterion.metric}: threshold passed but baseline check failed ` +
      `(dual comparison) — marking as failed`
    );
  }

  log.debug(
    `Criterion ${criterion.metric}: current=${currentValue}, ` +
    `operator=${criterion.operator}, threshold=${criterion.threshold}, ` +
    `threshold_passed=${thresholdPassed}, baseline_passed=${baselinePassed}, passed=${passed}`
  );

  return {
    metric: criterion.metric,
    current_value: currentValue,
    threshold: criterion.threshold,
    passed
  };
}

/**
 * Compute aggregate health score from evaluated criteria results.
 * Score = passed criteria count / total criteria count.
 *
 * @param {Array<{ passed: boolean }>} criteriaResults
 * @returns {number} Float between 0.0 and 1.0
 */
export function computeHealthScore(criteriaResults) {
  if (criteriaResults.length === 0) return 0;

  const passedCount = criteriaResults.filter(r => r.passed).length;
  return passedCount / criteriaResults.length;
}
