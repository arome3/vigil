// Failure analysis builder — produces a human-readable failure analysis
// string when verification fails. This string is passed directly to the
// Coordinator's reflection loop as the previous_failure_analysis argument.

import { createLogger } from '../../utils/logger.js';

const log = createLogger('verifier-analyzer');

/**
 * Find a baseline document matching the given metric name from the
 * baselines Map. Searches all services' baseline arrays.
 *
 * @param {Map<string, Array>} baselinesByService - Service → baseline docs
 * @param {string} metricName - Metric to find (e.g. 'error_rate')
 * @returns {object|null} Matching baseline document or null
 */
function findBaseline(baselinesByService, metricName) {
  for (const baselines of baselinesByService.values()) {
    const match = baselines.find(b => b.metric_name === metricName);
    if (match) return match;
  }
  return null;
}

/**
 * Build a structured failure analysis string from criteria that failed.
 * Returns null if all criteria passed (edge guard).
 *
 * The returned string is passed directly to the Coordinator's reflection
 * loop as `verifierResp.failure_analysis` → `handleReflectionLoop` arg →
 * `buildInvestigateRequest` `previous_failure_analysis` field.
 *
 * @param {Array<{ metric: string, current_value: number|null, threshold: number, passed: boolean }>} criteriaResults
 * @param {Map<string, Array>} baselinesByService - Service → baseline docs
 * @returns {string|null} Human-readable failure analysis or null if all passed
 */
export function buildFailureAnalysis(criteriaResults, baselinesByService) {
  const failed = criteriaResults.filter(r => !r.passed);
  if (failed.length === 0) return null;

  const parts = failed.map(criterion => {
    const baseline = findBaseline(baselinesByService, criterion.metric);
    const currentStr = criterion.current_value !== null
      ? String(criterion.current_value)
      : 'unavailable (query failed)';
    let part = `${criterion.metric}: current=${currentStr}, threshold=${criterion.threshold}`;
    if (baseline) {
      part += `, baseline=${baseline.avg_value}`;
    }
    return part;
  });

  const failedMetrics = failed.map(f => f.metric).join(', ');
  const passedCount = criteriaResults.filter(r => r.passed).length;

  const analysis =
    `Verification failed: ${failed.length} of ${criteriaResults.length} criteria not met ` +
    `(${passedCount} passed). Failed metrics: ${parts.join('; ')}. ` +
    `Recommendation: investigate why ${failedMetrics} have not recovered to acceptable levels.`;

  log.info(`Failure analysis produced: ${failed.length} failed criteria`);
  return analysis;
}
