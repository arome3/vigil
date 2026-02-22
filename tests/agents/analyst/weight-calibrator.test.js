// Jest test suite for the weight-calibrator analyst module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/analyst/weight-calibrator.test.js

import { jest } from '@jest/globals';

// --- Mock dependencies BEFORE importing module under test ---

const mockClientIndex = jest.fn().mockResolvedValue({});
const mockClientSearch = jest.fn().mockResolvedValue({ hits: { hits: [] } });
const mockExecuteEsqlTool = jest.fn();
const mockEmbedSafe = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: { index: mockClientIndex, search: mockClientSearch }
}));

jest.unstable_mockModule('../../../src/utils/retry.js', () => ({
  withRetry: jest.fn((fn) => fn()),
  isRetryable: jest.fn(() => false)
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.unstable_mockModule('../../../src/tools/esql/executor.js', () => ({
  executeEsqlTool: mockExecuteEsqlTool
}));

jest.unstable_mockModule('../../../src/utils/embed-helpers.js', () => ({
  embedSafe: mockEmbedSafe
}));

jest.unstable_mockModule('../../../src/utils/duration.js', () => ({
  parseDuration: jest.fn(() => 30 * 86400000)
}));

jest.unstable_mockModule('../../../src/utils/env.js', () => ({
  parseThreshold: (_env, def) => def,
  parsePositiveInt: (_env, def) => def,
  parsePositiveFloat: (_env, def) => def
}));

// Import after mocks
const { runWeightCalibration } = await import('../../../src/agents/analyst/weight-calibrator.js');

// --- Helpers ---

const COLUMNS = [
  { name: 'total' }, { name: 'correct' },
  { name: 'tp_count' }, { name: 'fp_count_binary' },
  { name: 'fn_count_binary' }, { name: 'tn_count' },
  { name: 'accuracy' }, { name: 'fn_rate' }, { name: 'fp_rate' }
];

// Default: FP-heavy bias (fp=40, fn=10 → fpBias ≈ 0.78 > 0.6)
function makeRow({ total = 100, correct = 60, tp = 30, fp = 40, fn = 10, tn = 20 } = {}) {
  return [total, correct, tp, fp, fn, tn, correct / total, fn / total, fp / total];
}

beforeEach(() => {
  jest.clearAllMocks();
});

// --- Tests ---

describe('runWeightCalibration', () => {
  it('returns null when no data returned', async () => {
    mockExecuteEsqlTool.mockResolvedValue({ columns: COLUMNS, values: [] });
    const result = await runWeightCalibration();
    expect(result).toBeNull();
    expect(mockClientIndex).not.toHaveBeenCalled();
  });

  it('returns null when insufficient data (< 20 incidents)', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 10, correct: 8, tp: 5, fp: 2, fn: 2, tn: 1 })]
    });
    const result = await runWeightCalibration();
    expect(result).toBeNull();
  });

  it('returns null when F1 >= threshold', async () => {
    // High TP, low FP/FN → high F1
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 90, tp: 80, fp: 2, fn: 3, tn: 15 })]
    });
    const result = await runWeightCalibration();
    expect(result).toBeNull();
  });

  it('proposes weights and writes learning record when F1 below threshold', async () => {
    // FP-heavy bias so we don't hit the balanced no-op guard
    // tp=30, fp=45, fn=10 → F1=2*30/(60+45+10)=60/115≈0.52 < 0.7
    // fpBias = 45/(45+10+1) ≈ 0.80 > 0.6 → fp_heavy
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 50, tp: 30, fp: 45, fn: 10, tn: 15 })]
    });
    const result = await runWeightCalibration();
    expect(result).not.toBeNull();
    expect(result.learning_type).toBe('weight_calibration');
    expect(result.data.proposed_weights).toBeDefined();
    expect(mockClientIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'vigil-learnings' })
    );
  });

  it('FP-heavy bias: severity decreases, fp_rate_inverse increases', async () => {
    // fpBias > 0.6: many FPs, few FNs
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 50, tp: 20, fp: 50, fn: 5, tn: 25 })]
    });
    const result = await runWeightCalibration();
    expect(result).not.toBeNull();
    const proposed = result.data.proposed_weights;
    expect(proposed.severity).toBeLessThan(0.30);
    expect(proposed.fp_rate_inverse).toBeGreaterThan(0.15);
    expect(result.data.error_direction).toBe('fp_heavy');
  });

  it('FN-heavy bias: severity increases', async () => {
    // fpBias < 0.4: many FNs, few FPs
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 50, tp: 20, fp: 5, fn: 50, tn: 25 })]
    });
    const result = await runWeightCalibration();
    expect(result).not.toBeNull();
    const proposed = result.data.proposed_weights;
    expect(proposed.severity).toBeGreaterThan(0.30);
    expect(result.data.error_direction).toBe('fn_heavy');
  });

  it('balanced bias → returns null (no-op guard)', async () => {
    // fpBias ≈ 0.5: equal FP and FN → all adjustments are 0
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 50, tp: 20, fp: 25, fn: 25, tn: 30 })]
    });
    const result = await runWeightCalibration();
    // With balanced bias, all adjustments are 0 → returns null
    expect(result).toBeNull();
    expect(mockClientIndex).not.toHaveBeenCalled();
  });

  it('weight normalization: sum equals 1.0', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 50, tp: 20, fp: 40, fn: 10, tn: 30 })]
    });
    const result = await runWeightCalibration();
    expect(result).not.toBeNull();
    const sum = Object.values(result.data.proposed_weights).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
  });

  it('embedding failure: record still written without vector', async () => {
    mockEmbedSafe.mockResolvedValue(undefined);
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow()]
    });
    const result = await runWeightCalibration();
    expect(result).not.toBeNull();
    expect(result.summary_vector).toBeUndefined();
    expect(mockClientIndex).toHaveBeenCalled();
  });

  it('embedding success: record includes vector', async () => {
    mockEmbedSafe.mockResolvedValue([0.1, 0.2, 0.3]);
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow()]
    });
    const result = await runWeightCalibration();
    expect(result).not.toBeNull();
    expect(result.summary_vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('confidence scales with sample size', async () => {
    // Confidence formula: min(0.95, max(0.5, log10(total)/3 * f1))
    // Need: small total floors at 0.5, large total exceeds 0.5
    // F1 must be < 0.7 (threshold) and bias must not be balanced

    // Small: total=100, tp=40, fp=25, fn=10 → F1≈0.696, fpBias≈0.694
    // confidence = log10(100)/3 * 0.696 = 0.667*0.696 = 0.464 → floor 0.5
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 100, correct: 65, tp: 40, fp: 25, fn: 10, tn: 25 })]
    });
    const smallResult = await runWeightCalibration();

    jest.clearAllMocks();
    mockClientSearch.mockResolvedValue({ hits: { hits: [] } });

    // Large: total=5000, tp=2000, fp=1250, fn=500 → F1≈0.696, fpBias≈0.714
    // confidence = log10(5000)/3 * 0.696 = 1.233*0.696 = 0.858
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow({ total: 5000, correct: 3250, tp: 2000, fp: 1250, fn: 500, tn: 1250 })]
    });
    const largeResult = await runWeightCalibration();

    expect(smallResult).not.toBeNull();
    expect(largeResult).not.toBeNull();
    // Larger sample → higher confidence (log-scale formula)
    expect(largeResult.confidence).toBeGreaterThan(smallResult.confidence);
  });
});
