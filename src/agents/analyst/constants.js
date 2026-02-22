import { parseThreshold, parsePositiveInt, parsePositiveFloat } from '../../utils/env.js';

// ── Weight Calibrator ────────────────────────────────────────

export const F1_THRESHOLD = parseThreshold('ANALYST_F1_THRESHOLD', 0.7);
export const MIN_SAMPLE_SIZE = parsePositiveInt('ANALYST_MIN_SAMPLE_SIZE', 20);

export const DEFAULT_WEIGHTS = Object.freeze({
  severity: 0.30,
  asset_criticality: 0.30,
  corroboration: 0.25,
  fp_rate_inverse: 0.15
});

export const FP_BIAS_HIGH = 0.6;
export const FP_BIAS_LOW = 0.4;

/**
 * ES|QL fp_rate comes as a percentage (e.g., 40.0 means 40%).
 * Divide by this constant to convert to a decimal (0.40).
 */
export const ESQL_PERCENTAGE_DIVISOR = 100;

// ── Threshold Tuner ──────────────────────────────────────────

export const MAX_ADJUSTMENT = 0.5;
export const FP_RATE_THRESHOLD = parsePositiveFloat('ANALYST_FP_RATE_THRESHOLD', 40.0);
export const MIN_DATA_POINTS = parsePositiveInt('ANALYST_MIN_DATA_POINTS', 10);

// ── Pattern Discoverer ───────────────────────────────────────

export const MIN_CLUSTER_SIZE = parsePositiveInt('ANALYST_MIN_CLUSTER_SIZE', 3);
export const JACCARD_THRESHOLD = parseThreshold('ANALYST_JACCARD_THRESHOLD', 0.70);
/**
 * Max incidents fetched for pattern clustering.
 * MAX_CLUSTER_SIZE must be <= PATTERN_SEARCH_SIZE. If MAX_CLUSTER_SIZE > PATTERN_SEARCH_SIZE,
 * a single cluster could never reach max size since total incidents are capped at PATTERN_SEARCH_SIZE.
 */
export const PATTERN_SEARCH_SIZE = parsePositiveInt('ANALYST_PATTERN_SEARCH_SIZE', 50);
export const MAX_CLUSTER_SIZE = parsePositiveInt('ANALYST_MAX_CLUSTER_SIZE', 20);

// ── Runbook Generator ────────────────────────────────────────

export const RUNBOOK_MATCH_THRESHOLD = parseThreshold('ANALYST_RUNBOOK_MATCH_THRESHOLD', 0.5);
export const HEALTH_SCORE_THRESHOLD = parseThreshold('ANALYST_HEALTH_SCORE_THRESHOLD', 0.8);
/**
 * BM25 min_score for runbook dedup. This value is index-dependent —
 * recalibrate after re-indexing vigil-runbooks or changing analyzers.
 */
export const DEDUP_MIN_SCORE = parsePositiveInt('ANALYST_DEDUP_MIN_SCORE', 15);

// ── Retrospective Writer ─────────────────────────────────────

export const TTR_WARN_SECONDS = parsePositiveInt('ANALYST_TTR_WARN_SECONDS', 300);
export const TTI_WARN_SECONDS = parsePositiveInt('ANALYST_TTI_WARN_SECONDS', 600);
export const REFLECTION_WARN_COUNT = parsePositiveInt('ANALYST_REFLECTION_WARN_COUNT', 2);

// ── Scheduler ────────────────────────────────────────────────

/**
 * Per-function deadline. Must be < BATCH_DEADLINE_MS or the per-function
 * timer will never fire (the batch timer wins first). Default: 120s < 300s.
 */
export const ANALYST_DEADLINE_MS = parsePositiveInt('ANALYST_DEADLINE_MS', 120000);
export const BATCH_DEADLINE_MS = parsePositiveInt('ANALYST_BATCH_DEADLINE_MS', 300000);
