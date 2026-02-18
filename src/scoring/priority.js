// Pure scoring module — zero I/O, zero Elasticsearch dependency.
// Implements the priority scoring formula from tech spec §4.2.

// --- Severity Normalization ---

const SEVERITY_MAP = {
  critical: 1.0,
  high: 0.8,
  medium: 0.5,
  low: 0.2
};

/**
 * Map a severity label to a numeric value (0.0–1.0).
 * Unknown/missing severity defaults to medium (0.5).
 *
 * @param {string} label - Severity label (critical, high, medium, low)
 * @returns {number} Normalized severity value
 */
export function normalizeSeverity(label) {
  if (!label || typeof label !== 'string') return SEVERITY_MAP.medium;
  return SEVERITY_MAP[label.toLowerCase()] ?? SEVERITY_MAP.medium;
}

// --- Asset Criticality Normalization ---

const CRITICALITY_MAP = {
  'tier-1': 1.0,
  'tier-2': 0.6,
  'tier-3': 0.3
};

/**
 * Map an asset criticality tier to a numeric value (0.0–1.0).
 * Missing/unknown tier defaults to tier-3 (0.3) per spec.
 *
 * @param {string} tier - Criticality tier (tier-1, tier-2, tier-3)
 * @returns {number} Normalized criticality value
 */
export function normalizeAssetCriticality(tier) {
  if (!tier || typeof tier !== 'string') return CRITICALITY_MAP['tier-3'];
  return CRITICALITY_MAP[tier.toLowerCase()] ?? CRITICALITY_MAP['tier-3'];
}

// --- Corroboration Normalization (Sigmoid) ---

// Sigmoid parameters calibrated so that:
//   f(72.5) ≈ 0.90  (high-score investigate example from spec)
//   f(1.5)  ≈ 0.06  (suppression example from spec)
//   f(0)    ≈ 0.057 (zero corroboration baseline)
const SIGMOID_MIDPOINT = 40;
const SIGMOID_STEEPNESS = 0.07;

/**
 * Normalize a raw risk_signal value to 0.0–1.0 using a sigmoid function.
 *
 * sigmoid(x) = 1 / (1 + exp(-k * (x - x0)))
 *
 * Where k=0.07, x0=40 (calibrated against spec test vectors).
 *
 * @param {number} riskSignal - Raw risk_signal from enrichment
 * @returns {number} Normalized corroboration score (0.0–1.0)
 */
export function normalizeCorroboration(riskSignal) {
  if (typeof riskSignal !== 'number' || Number.isNaN(riskSignal)) return 0;
  const x = Math.max(riskSignal, 0);
  return 1 / (1 + Math.exp(-SIGMOID_STEEPNESS * (x - SIGMOID_MIDPOINT)));
}

// --- Priority Scoring ---

/**
 * Compute the composite priority score from enrichment data.
 *
 * Formula (tech spec §4.2):
 *   priority_score = (threat_severity × 0.3)
 *                  + (asset_criticality × 0.3)
 *                  + (corroboration_score × 0.25)
 *                  + ((1 - historical_fp_rate) × 0.15)
 *
 * @param {object} enrichmentData
 * @param {string} enrichmentData.severity_original - Alert severity label
 * @param {number} enrichmentData.risk_signal - Raw risk signal from enrichment
 * @param {number} enrichmentData.historical_fp_rate - FP rate (0.0–1.0)
 * @param {string} enrichmentData.asset_criticality - Asset tier string
 * @returns {{ priority_score: number, contributing_factors: object }}
 */
export function scorePriority(enrichmentData) {
  const {
    severity_original,
    risk_signal = 0,
    historical_fp_rate = 0,
    asset_criticality
  } = enrichmentData;

  const threatSeverity = normalizeSeverity(severity_original);
  const assetCrit = normalizeAssetCriticality(asset_criticality);
  const corroboration = normalizeCorroboration(risk_signal);
  const novelty = 1 - (typeof historical_fp_rate === 'number' ? Math.min(Math.max(historical_fp_rate, 0), 1) : 0);

  const priority_score =
    (threatSeverity * 0.3) +
    (assetCrit * 0.3) +
    (corroboration * 0.25) +
    (novelty * 0.15);

  // Round to 4 decimal places to avoid floating-point noise
  const rounded = Math.round(priority_score * 10000) / 10000;

  return {
    priority_score: rounded,
    contributing_factors: {
      threat_severity: { raw: severity_original, normalized: threatSeverity, weight: 0.3 },
      asset_criticality: { raw: asset_criticality, normalized: assetCrit, weight: 0.3 },
      corroboration: { raw: risk_signal, normalized: Math.round(corroboration * 10000) / 10000, weight: 0.25 },
      historical_novelty: { raw_fp_rate: historical_fp_rate, normalized: Math.round(novelty * 10000) / 10000, weight: 0.15 }
    }
  };
}

// --- Disposition ---

/**
 * Determine alert disposition based on priority score and configurable thresholds.
 *
 * @param {number} score - Priority score (0.0–1.0)
 * @param {{ investigate: number, suppress: number }} thresholds
 * @returns {'investigate' | 'queue' | 'suppress'}
 */
export function determineDisposition(score, thresholds = {}) {
  const investigateThreshold = thresholds.investigate ?? 0.7;
  const suppressThreshold = thresholds.suppress ?? 0.4;

  if (score >= investigateThreshold) return 'investigate';
  if (score < suppressThreshold) return 'suppress';
  return 'queue';
}

// --- Suppression Reason ---

/**
 * Build a human-readable suppression explanation.
 * Only called when disposition is 'suppress'.
 *
 * @param {object} data - Enrichment data
 * @param {number} score - Computed priority score
 * @param {object} factors - Contributing factors from scorePriority()
 * @param {string} ruleId - Alert rule ID for context
 * @returns {string} Human-readable suppression reason
 */
export function generateSuppressionReason(data, score, factors, ruleId) {
  const parts = [];

  // Only describe each factor as "low" if it actually contributed to suppression.
  // A critical/tier-1 alert can still be suppressed by overwhelming FP rate —
  // the reason string should reflect what actually drove the low score.
  const severityLabel = data.severity_original || 'unknown';
  const severityVal = factors.threat_severity.normalized;
  if (severityVal <= 0.5) {
    parts.push(`Low severity (${severityLabel}=${severityVal})`);
  } else {
    parts.push(`Severity ${severityLabel} (${severityVal})`);
  }

  const tierLabel = data.asset_criticality || 'tier-3';
  const tierVal = factors.asset_criticality.normalized;
  if (tierVal <= 0.3) {
    parts.push(`low-criticality ${tierLabel} asset (${tierVal})`);
  } else {
    parts.push(`${tierLabel} asset (${tierVal})`);
  }

  const corrobVal = factors.corroboration.normalized;
  if (corrobVal < 0.1) {
    parts.push(`no corroborating signals (${corrobVal})`);
  } else if (corrobVal < 0.3) {
    parts.push(`low corroboration (${corrobVal})`);
  } else {
    parts.push(`corroboration score ${corrobVal}`);
  }

  const fpRate = data.historical_fp_rate;
  if (typeof fpRate === 'number' && fpRate > 0.5) {
    parts.push(`and high ${Math.round(fpRate * 100)}% historical FP rate for rule ${ruleId || 'unknown'}`);
  } else if (typeof fpRate === 'number' && fpRate > 0) {
    parts.push(`and ${Math.round(fpRate * 100)}% historical FP rate for rule ${ruleId || 'unknown'}`);
  }

  parts.push(`Score ${score} below suppress threshold 0.4.`);

  return parts.join(', ');
}
