// Jest test suite for the retrospective-writer analyst module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/analyst/retrospective-writer.test.js

import { jest } from '@jest/globals';

// --- Mock dependencies ---

const mockClientIndex = jest.fn().mockResolvedValue({});
const mockClientSearch = jest.fn();
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

jest.unstable_mockModule('../../../src/utils/embed-helpers.js', () => ({
  embedSafe: mockEmbedSafe
}));

jest.unstable_mockModule('../../../src/utils/retry.js', () => ({
  withRetry: jest.fn((fn) => fn()),
  isRetryable: jest.fn(() => false)
}));

jest.unstable_mockModule('../../../src/utils/env.js', () => ({
  parseThreshold: (_env, def) => def,
  parsePositiveInt: (_env, def) => def,
  parsePositiveFloat: (_env, def) => def
}));

const { runRetrospective } = await import('../../../src/agents/analyst/retrospective-writer.js');

// --- Helpers ---

function makeIncidentData(overrides = {}) {
  return {
    incident_id: 'INC-TEST-001',
    incident_type: 'security',
    severity: 'high',
    status: 'resolved',
    created_at: '2025-01-15T10:00:00Z',
    resolved_at: '2025-01-15T11:30:00Z',
    reflection_count: 0,
    root_cause: 'Brute force attack on API gateway',
    investigation_summary: 'Detected credential stuffing',
    _state_timestamps: {
      detected: '2025-01-15T10:00:30Z',
      triaged: '2025-01-15T10:01:00Z',
      investigating: '2025-01-15T10:05:00Z',
      executing: '2025-01-15T10:30:00Z',
      verifying: '2025-01-15T11:00:00Z'
    },
    remediation_plan: {
      actions: [
        { action_type: 'ip_block', description: 'Block source IPs', order: 1 },
        { action_type: 'credential_rotation', description: 'Rotate compromised credentials', order: 2 }
      ],
      runbook_match_score: 0.3
    },
    verification_results: [
      { health_score: 0.95, checks_passed: 5, checks_failed: 0 }
    ],
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Mock telemetry query (aggregation-based)
  mockClientSearch.mockResolvedValue({
    hits: { hits: [] },
    aggregations: {
      by_agent: {
        buckets: [
          { key: 'investigator', total_exec_ms: { value: 5000 }, total_calls: { value: 3 }, error_count: { doc_count: 0 } },
          { key: 'executor', total_exec_ms: { value: 3000 }, total_calls: { value: 2 }, error_count: { doc_count: 0 } }
        ]
      }
    }
  });
});

// --- Tests ---

describe('runRetrospective', () => {
  it('generates full retrospective: timeline, timing, root cause, recommendations', async () => {
    const result = await runRetrospective(makeIncidentData());

    expect(result).not.toBeNull();
    expect(result.learning_type).toBe('retrospective');
    expect(result.data.timeline).toBeDefined();
    expect(result.data.timing_metrics).toBeDefined();
    expect(result.data.root_cause).toBe('Brute force attack on API gateway');
    expect(result.data.improvement_recommendations).toBeDefined();
    expect(result.data.agent_performance.length).toBeGreaterThan(0);
    expect(mockClientIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'vigil-learnings' })
    );
  });

  it('root cause: resolved first-attempt → {accurate: true, basis: inferred_from_first_attempt_success}', async () => {
    const result = await runRetrospective(makeIncidentData({
      status: 'resolved',
      reflection_count: 0
    }));
    expect(result.data.root_cause_accurate).toBe(true);
    expect(result.data.root_cause_assessment_basis).toBe('inferred_from_first_attempt_success');
  });

  it('root cause: escalated → {accurate: false, basis: inferred_from_escalation}', async () => {
    const result = await runRetrospective(makeIncidentData({
      status: 'escalated',
      reflection_count: 0
    }));
    expect(result.data.root_cause_accurate).toBe(false);
    expect(result.data.root_cause_assessment_basis).toBe('inferred_from_escalation');
  });

  it('recommendation: high reflections', async () => {
    const result = await runRetrospective(makeIncidentData({
      reflection_count: 3
    }));
    const recs = result.data.improvement_recommendations;
    expect(recs.some(r => r.includes('reflection count'))).toBe(true);
  });

  it('recommendation: slow TTR', async () => {
    const result = await runRetrospective(makeIncidentData({
      _state_timestamps: {
        detected: '2025-01-15T10:00:00Z',
        triaged: '2025-01-15T10:01:00Z',
        executing: '2025-01-15T10:05:00Z',
        verifying: '2025-01-15T10:15:00Z' // 10 min TTR = 600s > 300s threshold
      }
    }));
    const recs = result.data.improvement_recommendations;
    expect(recs.some(r => r.includes('Remediation took'))).toBe(true);
  });

  it('recommendation: slow TTI', async () => {
    const result = await runRetrospective(makeIncidentData({
      _state_timestamps: {
        detected: '2025-01-15T10:00:00Z',
        triaged: '2025-01-15T10:01:00Z',
        investigating: '2025-01-15T10:05:00Z',
        executing: '2025-01-15T10:25:00Z', // 24 min TTI = 1440s > 600s threshold
        verifying: '2025-01-15T10:30:00Z'
      }
    }));
    const recs = result.data.improvement_recommendations;
    expect(recs.some(r => r.includes('Investigation phase'))).toBe(true);
  });

  it('recommendation: escalation', async () => {
    const result = await runRetrospective(makeIncidentData({
      status: 'escalated',
      escalation_reason: 'reflection_limit_reached'
    }));
    const recs = result.data.improvement_recommendations;
    expect(recs.some(r => r.includes('escalated'))).toBe(true);
  });

  it('recommendation: missing telemetry', async () => {
    mockClientSearch.mockResolvedValue({ hits: { hits: [] }, aggregations: { by_agent: { buckets: [] } } });

    const result = await runRetrospective(makeIncidentData());
    const recs = result.data.improvement_recommendations;
    expect(recs.some(r => r.includes('No agent telemetry'))).toBe(true);
  });

  it('malformed dates do not crash', async () => {
    const result = await runRetrospective(makeIncidentData({
      created_at: 'not-a-date',
      resolved_at: 'also-bad',
      _state_timestamps: {
        detected: 'invalid',
        triaged: 'nope'
      }
    }));
    expect(result).not.toBeNull();
    expect(result.data.timing_metrics.ttd_seconds).toBeNull();
    expect(result.data.timing_metrics.total_seconds).toBeNull();
  });
});
