import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSeverity,
  normalizeAssetCriticality,
  normalizeCorroboration,
  scorePriority,
  determineDisposition,
  generateSuppressionReason
} from '../../../src/scoring/priority.js';

// ─── normalizeSeverity ──────────────────────────────────────

describe('normalizeSeverity', () => {
  it('maps critical → 1.0', () => {
    assert.equal(normalizeSeverity('critical'), 1.0);
  });

  it('maps high → 0.8', () => {
    assert.equal(normalizeSeverity('high'), 0.8);
  });

  it('maps medium → 0.5', () => {
    assert.equal(normalizeSeverity('medium'), 0.5);
  });

  it('maps low → 0.2', () => {
    assert.equal(normalizeSeverity('low'), 0.2);
  });

  it('is case insensitive', () => {
    assert.equal(normalizeSeverity('CRITICAL'), 1.0);
    assert.equal(normalizeSeverity('High'), 0.8);
    assert.equal(normalizeSeverity('LOW'), 0.2);
  });

  it('defaults null to medium (0.5)', () => {
    assert.equal(normalizeSeverity(null), 0.5);
  });

  it('defaults undefined to medium (0.5)', () => {
    assert.equal(normalizeSeverity(undefined), 0.5);
  });

  it('defaults unknown strings to medium (0.5)', () => {
    assert.equal(normalizeSeverity('extreme'), 0.5);
    assert.equal(normalizeSeverity(''), 0.5);
  });

  it('defaults non-string types to medium (0.5)', () => {
    assert.equal(normalizeSeverity(42), 0.5);
    assert.equal(normalizeSeverity(true), 0.5);
  });
});

// ─── normalizeAssetCriticality ──────────────────────────────

describe('normalizeAssetCriticality', () => {
  it('maps tier-1 → 1.0', () => {
    assert.equal(normalizeAssetCriticality('tier-1'), 1.0);
  });

  it('maps tier-2 → 0.6', () => {
    assert.equal(normalizeAssetCriticality('tier-2'), 0.6);
  });

  it('maps tier-3 → 0.3', () => {
    assert.equal(normalizeAssetCriticality('tier-3'), 0.3);
  });

  it('defaults null to tier-3 (0.3)', () => {
    assert.equal(normalizeAssetCriticality(null), 0.3);
  });

  it('defaults undefined to tier-3 (0.3)', () => {
    assert.equal(normalizeAssetCriticality(undefined), 0.3);
  });

  it('defaults unknown strings to tier-3 (0.3)', () => {
    assert.equal(normalizeAssetCriticality('tier-4'), 0.3);
    assert.equal(normalizeAssetCriticality(''), 0.3);
  });

  it('is case insensitive', () => {
    assert.equal(normalizeAssetCriticality('TIER-1'), 1.0);
    assert.equal(normalizeAssetCriticality('Tier-2'), 0.6);
  });
});

// ─── normalizeCorroboration ─────────────────────────────────

describe('normalizeCorroboration', () => {
  it('returns ~0.057 for riskSignal=0 (zero corroboration baseline)', () => {
    const result = normalizeCorroboration(0);
    assert.ok(result > 0.05 && result < 0.07, `expected ~0.057, got ${result}`);
  });

  it('returns ~0.5 for riskSignal=40 (sigmoid midpoint)', () => {
    const result = normalizeCorroboration(40);
    assert.ok(Math.abs(result - 0.5) < 0.01, `expected ~0.5, got ${result}`);
  });

  it('returns ~0.90 for riskSignal=72.5 (spec investigate vector)', () => {
    const result = normalizeCorroboration(72.5);
    assert.ok(result > 0.88 && result < 0.93, `expected ~0.90, got ${result}`);
  });

  it('returns ~0.06 for riskSignal=1.5 (spec suppression vector)', () => {
    const result = normalizeCorroboration(1.5);
    assert.ok(result > 0.04 && result < 0.08, `expected ~0.06, got ${result}`);
  });

  it('returns 0 for NaN', () => {
    assert.equal(normalizeCorroboration(NaN), 0);
  });

  it('returns 0 for non-number types', () => {
    assert.equal(normalizeCorroboration('hello'), 0);
    assert.equal(normalizeCorroboration(null), 0);
    assert.equal(normalizeCorroboration(undefined), 0);
  });

  it('clamps negative values to 0 (same as riskSignal=0)', () => {
    const atZero = normalizeCorroboration(0);
    const atNeg = normalizeCorroboration(-10);
    assert.equal(atNeg, atZero);
  });

  it('approaches 1.0 for large values', () => {
    const result = normalizeCorroboration(200);
    assert.ok(result > 0.99, `expected >0.99, got ${result}`);
  });
});

// ─── scorePriority ──────────────────────────────────────────

describe('scorePriority', () => {
  it('computes high score for spec investigate vector (critical/tier-1/72.5/0.02)', () => {
    const { priority_score, contributing_factors } = scorePriority({
      severity_original: 'critical',
      risk_signal: 72.5,
      historical_fp_rate: 0.02,
      asset_criticality: 'tier-1'
    });

    // severity(1.0)*0.3 + criticality(1.0)*0.3 + corroboration(~0.90)*0.25 + novelty(0.98)*0.15
    // = 0.3 + 0.3 + ~0.225 + 0.147 ≈ 0.972
    assert.ok(priority_score >= 0.7, `expected >= 0.7 for investigate, got ${priority_score}`);
    assert.equal(contributing_factors.threat_severity.normalized, 1.0);
    assert.equal(contributing_factors.asset_criticality.normalized, 1.0);
    assert.equal(contributing_factors.threat_severity.weight, 0.3);
    assert.equal(contributing_factors.asset_criticality.weight, 0.3);
    assert.equal(contributing_factors.corroboration.weight, 0.25);
    assert.equal(contributing_factors.historical_novelty.weight, 0.15);
  });

  it('computes low score for spec suppression vector (low/tier-3/1.5/0.85)', () => {
    const { priority_score } = scorePriority({
      severity_original: 'low',
      risk_signal: 1.5,
      historical_fp_rate: 0.85,
      asset_criticality: 'tier-3'
    });

    // severity(0.2)*0.3 + criticality(0.3)*0.3 + corroboration(~0.06)*0.25 + novelty(0.15)*0.15
    // = 0.06 + 0.09 + ~0.015 + 0.0225 ≈ 0.1875
    assert.ok(priority_score < 0.4, `expected < 0.4 for suppress, got ${priority_score}`);
  });

  it('computes mid-range score (medium/tier-2/30/0.3)', () => {
    const { priority_score } = scorePriority({
      severity_original: 'medium',
      risk_signal: 30,
      historical_fp_rate: 0.3,
      asset_criticality: 'tier-2'
    });

    assert.ok(priority_score >= 0.4 && priority_score < 0.7,
      `expected 0.4-0.7 for queue, got ${priority_score}`);
  });

  it('weights sum to 1.0', () => {
    const { contributing_factors } = scorePriority({
      severity_original: 'medium',
      risk_signal: 0,
      historical_fp_rate: 0,
      asset_criticality: 'tier-2'
    });

    const totalWeight =
      contributing_factors.threat_severity.weight +
      contributing_factors.asset_criticality.weight +
      contributing_factors.corroboration.weight +
      contributing_factors.historical_novelty.weight;

    assert.equal(totalWeight, 1.0);
  });

  it('clamps fp_rate to [0, 1]', () => {
    const { contributing_factors: fNeg } = scorePriority({
      severity_original: 'medium',
      risk_signal: 0,
      historical_fp_rate: -0.5,
      asset_criticality: 'tier-2'
    });
    assert.equal(fNeg.historical_novelty.normalized, 1.0);

    const { contributing_factors: fOver } = scorePriority({
      severity_original: 'medium',
      risk_signal: 0,
      historical_fp_rate: 1.5,
      asset_criticality: 'tier-2'
    });
    assert.equal(fOver.historical_novelty.normalized, 0.0);
  });

  it('uses defaults for missing fields', () => {
    const { priority_score, contributing_factors } = scorePriority({});

    // severity defaults to medium(0.5), criticality to tier-3(0.3),
    // risk_signal to 0, fp_rate to 0
    assert.equal(contributing_factors.threat_severity.normalized, 0.5);
    assert.equal(contributing_factors.asset_criticality.normalized, 0.3);
    assert.equal(contributing_factors.historical_novelty.raw_fp_rate, 0);
    assert.ok(typeof priority_score === 'number');
  });

  it('rounds to 4 decimal places', () => {
    const { priority_score } = scorePriority({
      severity_original: 'critical',
      risk_signal: 72.5,
      historical_fp_rate: 0.02,
      asset_criticality: 'tier-1'
    });

    const decimalStr = priority_score.toString().split('.')[1] || '';
    assert.ok(decimalStr.length <= 4, `expected <=4 decimal places, got ${decimalStr.length}`);
  });
});

// ─── determineDisposition ───────────────────────────────────

describe('determineDisposition', () => {
  it('returns "investigate" at threshold (0.7)', () => {
    assert.equal(determineDisposition(0.7), 'investigate');
  });

  it('returns "investigate" above threshold', () => {
    assert.equal(determineDisposition(0.95), 'investigate');
  });

  it('returns "queue" just below investigate threshold (0.69)', () => {
    assert.equal(determineDisposition(0.69), 'queue');
  });

  it('returns "queue" at suppress boundary (0.4)', () => {
    assert.equal(determineDisposition(0.4), 'queue');
  });

  it('returns "suppress" just below suppress threshold (0.39)', () => {
    assert.equal(determineDisposition(0.39), 'suppress');
  });

  it('returns "suppress" at zero', () => {
    assert.equal(determineDisposition(0.0), 'suppress');
  });

  it('respects custom thresholds', () => {
    assert.equal(determineDisposition(0.5, { investigate: 0.5, suppress: 0.2 }), 'investigate');
    assert.equal(determineDisposition(0.3, { investigate: 0.5, suppress: 0.2 }), 'queue');
    assert.equal(determineDisposition(0.1, { investigate: 0.5, suppress: 0.2 }), 'suppress');
  });
});

// ─── generateSuppressionReason ──────────────────────────────

describe('generateSuppressionReason', () => {
  const lowData = {
    severity_original: 'low',
    asset_criticality: 'tier-3',
    historical_fp_rate: 0.85
  };

  const { contributing_factors: lowFactors } = scorePriority({
    severity_original: 'low',
    risk_signal: 1.5,
    historical_fp_rate: 0.85,
    asset_criticality: 'tier-3'
  });

  it('includes severity label', () => {
    const reason = generateSuppressionReason(lowData, 0.19, lowFactors, 'rule-123');
    assert.ok(reason.includes('low'), `expected severity label in: ${reason}`);
  });

  it('includes criticality tier', () => {
    const reason = generateSuppressionReason(lowData, 0.19, lowFactors, 'rule-123');
    assert.ok(reason.includes('tier-3'), `expected tier label in: ${reason}`);
  });

  it('includes corroboration description', () => {
    const reason = generateSuppressionReason(lowData, 0.19, lowFactors, 'rule-123');
    // corroboration is ~0.06 which is < 0.1 → "no corroborating signals"
    assert.ok(reason.includes('corroborat'), `expected corroboration mention in: ${reason}`);
  });

  it('includes FP rate for high FP', () => {
    const reason = generateSuppressionReason(lowData, 0.19, lowFactors, 'rule-123');
    assert.ok(reason.includes('85%'), `expected FP rate percentage in: ${reason}`);
    assert.ok(reason.includes('rule-123'), `expected rule ID in: ${reason}`);
  });

  it('includes threshold text', () => {
    const reason = generateSuppressionReason(lowData, 0.19, lowFactors, 'rule-123');
    assert.ok(reason.includes('0.4'), `expected threshold in: ${reason}`);
  });

  it('handles missing rule ID gracefully', () => {
    const reason = generateSuppressionReason(lowData, 0.19, lowFactors, null);
    assert.ok(reason.includes('unknown'), `expected 'unknown' rule in: ${reason}`);
  });

  // --- Branch coverage: high severity suppressed by overwhelming FP rate ---

  it('shows "Severity critical" (not "Low severity") when severity is high', () => {
    // A critical alert CAN be suppressed if FP rate is extremely high
    // and corroboration/criticality are low enough
    const highSevData = {
      severity_original: 'critical',
      asset_criticality: 'tier-3',
      historical_fp_rate: 0.95
    };
    const { contributing_factors: highSevFactors } = scorePriority({
      severity_original: 'critical',
      risk_signal: 0,
      historical_fp_rate: 0.95,
      asset_criticality: 'tier-3'
    });

    const reason = generateSuppressionReason(highSevData, 0.35, highSevFactors, 'rule-456');
    // severityVal = 1.0, which is > 0.5, so should NOT say "Low severity"
    assert.ok(reason.includes('Severity critical'), `expected "Severity critical" in: ${reason}`);
    assert.ok(!reason.includes('Low severity'), `should not say "Low severity" for critical: ${reason}`);
  });

  it('shows high-criticality tier label when tier is not low', () => {
    const midTierData = {
      severity_original: 'low',
      asset_criticality: 'tier-2',
      historical_fp_rate: 0.9
    };
    const { contributing_factors: midTierFactors } = scorePriority({
      severity_original: 'low',
      risk_signal: 0,
      historical_fp_rate: 0.9,
      asset_criticality: 'tier-2'
    });

    const reason = generateSuppressionReason(midTierData, 0.2, midTierFactors, 'rule-789');
    // tierVal = 0.6, which is > 0.3, so should NOT say "low-criticality"
    assert.ok(reason.includes('tier-2 asset'), `expected "tier-2 asset" in: ${reason}`);
    assert.ok(!reason.includes('low-criticality'), `should not say "low-criticality" for tier-2: ${reason}`);
  });

  it('shows "low corroboration" when corroboration is between 0.1 and 0.3', () => {
    // Need a risk_signal that produces corroboration in [0.1, 0.3]
    // sigmoid(20) ≈ 0.20
    const midCorrData = {
      severity_original: 'low',
      asset_criticality: 'tier-3',
      historical_fp_rate: 0.8
    };
    const { contributing_factors: midCorrFactors } = scorePriority({
      severity_original: 'low',
      risk_signal: 20,
      historical_fp_rate: 0.8,
      asset_criticality: 'tier-3'
    });

    const reason = generateSuppressionReason(midCorrData, 0.2, midCorrFactors, 'rule-abc');
    assert.ok(reason.includes('low corroboration'), `expected "low corroboration" in: ${reason}`);
  });

  it('shows "corroboration score X" when corroboration >= 0.3', () => {
    // Need risk_signal that produces corroboration >= 0.3
    // sigmoid(30) ≈ 0.33
    const highCorrData = {
      severity_original: 'low',
      asset_criticality: 'tier-3',
      historical_fp_rate: 0.95
    };
    const { contributing_factors: highCorrFactors } = scorePriority({
      severity_original: 'low',
      risk_signal: 35,
      historical_fp_rate: 0.95,
      asset_criticality: 'tier-3'
    });

    const reason = generateSuppressionReason(highCorrData, 0.2, highCorrFactors, 'rule-def');
    assert.ok(reason.includes('corroboration score'), `expected "corroboration score" in: ${reason}`);
    assert.ok(!reason.includes('low corroboration'), `should not say "low corroboration": ${reason}`);
    assert.ok(!reason.includes('no corroborating'), `should not say "no corroborating": ${reason}`);
  });

  it('shows non-"high" FP rate label when 0 < fp_rate <= 0.5', () => {
    const midFpData = {
      severity_original: 'low',
      asset_criticality: 'tier-3',
      historical_fp_rate: 0.3
    };
    const { contributing_factors: midFpFactors } = scorePriority({
      severity_original: 'low',
      risk_signal: 0,
      historical_fp_rate: 0.3,
      asset_criticality: 'tier-3'
    });

    const reason = generateSuppressionReason(midFpData, 0.2, midFpFactors, 'rule-ghi');
    assert.ok(reason.includes('30%'), `expected "30%" in: ${reason}`);
    assert.ok(!reason.includes('high'), `should not say "high" FP rate for 30%: ${reason}`);
  });

  it('omits FP rate mention when fp_rate is 0', () => {
    const zeroFpData = {
      severity_original: 'low',
      asset_criticality: 'tier-3',
      historical_fp_rate: 0
    };
    const { contributing_factors: zeroFpFactors } = scorePriority({
      severity_original: 'low',
      risk_signal: 0,
      historical_fp_rate: 0,
      asset_criticality: 'tier-3'
    });

    const reason = generateSuppressionReason(zeroFpData, 0.2, zeroFpFactors, 'rule-jkl');
    assert.ok(!reason.includes('FP rate'), `should not mention FP rate when it's 0: ${reason}`);
    assert.ok(!reason.includes('rule-jkl'), `should not mention rule when FP rate is 0: ${reason}`);
  });
});
