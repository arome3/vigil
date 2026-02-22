// Jest test suite for the runbook-generator analyst module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/analyst/runbook-generator.test.js

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

const { runRunbookGeneration } = await import('../../../src/agents/analyst/runbook-generator.js');

// --- Helpers ---

function makeIncidentData(overrides = {}) {
  return {
    incident_id: 'INC-RBK-001',
    incident_type: 'security',
    severity: 'high',
    status: 'resolved',
    created_at: '2025-01-15T10:00:00Z',
    resolved_at: '2025-01-15T11:00:00Z',
    reflection_count: 0,
    root_cause: 'Brute force attack on API gateway',
    investigation_summary: 'Detected credential stuffing',
    remediation_plan: {
      runbook_match_score: 0.2,
      actions: [
        { action_type: 'ip_block', description: 'Block source IPs', order: 1, target_system: 'firewall' },
        { action_type: 'credential_rotation', description: 'Rotate creds', order: 2, target_system: 'iam' }
      ]
    },
    verification_results: [
      { health_score: 0.95 }
    ],
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no existing runbooks (dedup passes)
  mockClientSearch.mockResolvedValue({ hits: { hits: [] } });
});

// --- Tests ---

describe('runRunbookGeneration', () => {
  it('eligible incident → writes runbook + learning record', async () => {
    const result = await runRunbookGeneration(makeIncidentData());

    expect(result).not.toBeNull();
    expect(result.learning_type).toBe('runbook_generation');
    expect(result.data.generated_runbook.runbook_id).toMatch(/^rbk-auto-/);

    // Should write to both vigil-runbooks and vigil-learnings
    const indexCalls = mockClientIndex.mock.calls.map(c => c[0].index);
    expect(indexCalls).toContain('vigil-runbooks');
    expect(indexCalls).toContain('vigil-learnings');
  });

  it('dedup: similar runbook exists → returns null', async () => {
    mockClientSearch.mockResolvedValue({
      hits: {
        hits: [{ _source: { runbook_id: 'rbk-existing' }, _max_score: 20 }]
      }
    });

    const result = await runRunbookGeneration(makeIncidentData());
    expect(result).toBeNull();
    // Should not write anything
    expect(mockClientIndex).not.toHaveBeenCalled();
  });

  it('dedup failure → graceful degradation, proceeds with generation', async () => {
    mockClientSearch.mockRejectedValue(new Error('Elasticsearch unavailable'));

    const result = await runRunbookGeneration(makeIncidentData());
    // Should still generate
    expect(result).not.toBeNull();
    expect(result.learning_type).toBe('runbook_generation');
  });

  it('ineligible: not resolved → null', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      status: 'escalated'
    }));
    expect(result).toBeNull();
  });

  it('ineligible: high match score → null', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      remediation_plan: {
        runbook_match_score: 0.8,
        actions: [{ action_type: 'ip_block', description: 'Block IPs', order: 1 }]
      }
    }));
    expect(result).toBeNull();
  });

  it('ineligible: reflections > 0 → null', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      reflection_count: 2
    }));
    expect(result).toBeNull();
  });

  it('ineligible: low health score → null', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      verification_results: [{ health_score: 0.5 }]
    }));
    expect(result).toBeNull();
  });

  it('title capped at 2 action types', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      remediation_plan: {
        runbook_match_score: 0.1,
        actions: [
          { action_type: 'ip_block', description: 'Step 1', order: 1, target_system: 'fw' },
          { action_type: 'credential_rotation', description: 'Step 2', order: 2, target_system: 'iam' },
          { action_type: 'pod_restart', description: 'Step 3', order: 3, target_system: 'k8s' }
        ]
      }
    }));

    expect(result).not.toBeNull();
    const title = result.data.generated_runbook.title;
    // Should have "..." suffix for 3+ action types
    expect(title).toContain('...');
    // Should not contain the third action type
    expect(title).not.toContain('Pod Restart');
  });

  it('severity_applicability is empty array when no severity', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      severity: undefined
    }));
    expect(result).not.toBeNull();
    expect(result.data.generated_runbook.severity_applicability).toEqual([]);
  });

  it('reflection_count undefined → treated as 0 (eligible)', async () => {
    const result = await runRunbookGeneration(makeIncidentData({
      reflection_count: undefined
    }));
    // reflection_count || 0 → 0, so eligible
    expect(result).not.toBeNull();
    expect(result.learning_type).toBe('runbook_generation');
  });

  it('learning record write failure → function throws (runbook still exists)', async () => {
    let callCount = 0;
    mockClientIndex.mockImplementation(async (params) => {
      callCount++;
      if (callCount === 2) {
        // Second call is learning record write — fail it
        throw new Error('ES write failure');
      }
      return {};
    });

    await expect(runRunbookGeneration(makeIncidentData())).rejects.toThrow('ES write failure');

    // First call (runbook) should have succeeded
    expect(mockClientIndex.mock.calls[0][0].index).toBe('vigil-runbooks');
  });
});
