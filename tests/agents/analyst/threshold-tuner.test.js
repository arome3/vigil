// Jest test suite for the threshold-tuner analyst module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/analyst/threshold-tuner.test.js

import { jest } from '@jest/globals';

// --- Mock dependencies ---

const mockClientIndex = jest.fn().mockResolvedValue({});
const mockClientSearch = jest.fn();
const mockExecuteEsqlTool = jest.fn();
const mockEmbedSafe = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: { index: mockClientIndex, search: mockClientSearch }
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

jest.unstable_mockModule('../../../src/utils/retry.js', () => ({
  withRetry: jest.fn((fn) => fn()),
  isRetryable: jest.fn(() => false)
}));

jest.unstable_mockModule('../../../src/utils/duration.js', () => ({
  parseDuration: jest.fn(() => 14 * 86400000)
}));

jest.unstable_mockModule('../../../src/utils/env.js', () => ({
  parseThreshold: (_env, def) => def,
  parsePositiveInt: (_env, def) => def,
  parsePositiveFloat: (_env, def) => def
}));

const { runThresholdTuning } = await import('../../../src/agents/analyst/threshold-tuner.js');

// --- Helpers ---

const COLUMNS = [
  { name: 'affected_service' }, { name: 'total_detections' },
  { name: 'true_positives' }, { name: 'false_positives' },
  { name: 'fp_rate' }, { name: 'recommended_threshold' },
  { name: 'avg_deviation' }, { name: 'precision' }
];

function makeRow(service, detections, tp, fp, fpRate, recommended) {
  return [service, detections, tp, fp, fpRate, recommended, 1.5, tp / detections];
}

function mockBatchThresholds(thresholdMap) {
  mockClientSearch.mockImplementation(async (params) => {
    if (params.index === 'vigil-baselines') {
      const hits = [];
      for (const [svc, val] of Object.entries(thresholdMap)) {
        hits.push({ _source: { service_name: svc, stddev_value: val } });
      }
      return { hits: { hits } };
    }
    return { hits: { hits: [] } };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchThresholds({});
});

// --- Tests ---

describe('runThresholdTuning', () => {
  it('returns null when no data returned', async () => {
    mockExecuteEsqlTool.mockResolvedValue({ columns: COLUMNS, values: [] });
    const result = await runThresholdTuning();
    expect(result).toBeNull();
  });

  it('high FP rate → proposes threshold increase', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow('api-gateway', 50, 25, 25, 60.0, 3.0)]
    });
    mockBatchThresholds({ 'api-gateway': 2.0 });

    const result = await runThresholdTuning();
    expect(result).not.toBeNull();
    const svc = result.data.per_service_analysis[0];
    expect(svc.direction).toBe('increase');
    expect(svc.proposed_threshold).toBeGreaterThan(2.0);
  });

  it('ES|QL recommended != current → follows recommendation', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow('payment-svc', 30, 28, 2, 5.0, 2.5)]
    });
    mockBatchThresholds({ 'payment-svc': 2.0 });

    const result = await runThresholdTuning();
    expect(result).not.toBeNull();
    const svc = result.data.per_service_analysis[0];
    expect(svc.direction).toBe('increase');
  });

  it('well-calibrated → returns null', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow('user-svc', 30, 28, 2, 5.0, 2.0)]
    });
    mockBatchThresholds({ 'user-svc': 2.0 });

    const result = await runThresholdTuning();
    expect(result).toBeNull();
  });

  it('insufficient data → unchanged in analysis', async () => {
    // Two services: one with enough data, one without
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [
        makeRow('small-svc', 5, 3, 2, 40.0, 2.5),
        makeRow('big-svc', 50, 25, 25, 60.0, 3.0)
      ]
    });
    mockBatchThresholds({ 'small-svc': 2.0, 'big-svc': 2.0 });

    const result = await runThresholdTuning();
    expect(result).not.toBeNull();
    const small = result.data.per_service_analysis.find(s => s.service_name === 'small-svc');
    expect(small.direction).toBe('unchanged');
    const big = result.data.per_service_analysis.find(s => s.service_name === 'big-svc');
    expect(big.direction).toBe('increase');
  });

  it('batch threshold fetch: single ES query for multiple services', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [
        makeRow('svc-a', 50, 25, 25, 60.0, 3.0),
        makeRow('svc-b', 50, 48, 2, 4.0, 1.8)
      ]
    });
    mockBatchThresholds({ 'svc-a': 2.0, 'svc-b': 2.0 });

    await runThresholdTuning();

    // Only ONE call to client.search for baselines (batch)
    const baselineCalls = mockClientSearch.mock.calls.filter(
      c => c[0].index === 'vigil-baselines'
    );
    expect(baselineCalls.length).toBe(1);
  });

  it('direction: delta==0 → "unchanged"', async () => {
    // recommended == current, but other conditions would trigger non-null
    // Need a mix: one service changed, one not
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [
        makeRow('changed-svc', 50, 25, 25, 60.0, 3.0),
        makeRow('same-svc', 50, 48, 2, 5.0, 2.0)
      ]
    });
    mockBatchThresholds({ 'changed-svc': 2.0, 'same-svc': 2.0 });

    const result = await runThresholdTuning();
    expect(result).not.toBeNull();
    const same = result.data.per_service_analysis.find(s => s.service_name === 'same-svc');
    expect(same.direction).toBe('unchanged');
  });

  it('recommended < current → direction: decrease', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [makeRow('alert-svc', 50, 48, 2, 4.0, 1.5)]
    });
    mockBatchThresholds({ 'alert-svc': 2.0 });

    const result = await runThresholdTuning();
    expect(result).not.toBeNull();
    const svc = result.data.per_service_analysis.find(s => s.service_name === 'alert-svc');
    expect(svc.direction).toBe('decrease');
    expect(svc.proposed_threshold).toBeLessThan(2.0);
  });

  it('incident_count → summed total_detections, not row count', async () => {
    mockExecuteEsqlTool.mockResolvedValue({
      columns: COLUMNS,
      values: [
        makeRow('svc-a', 30, 10, 20, 66.0, 3.0),
        makeRow('svc-b', 70, 20, 50, 71.0, 3.5)
      ]
    });
    mockBatchThresholds({ 'svc-a': 2.0, 'svc-b': 2.0 });

    const result = await runThresholdTuning();
    expect(result).not.toBeNull();
    expect(result.analysis_window.incident_count).toBe(100);
  });
});
