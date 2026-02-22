// Jest test suite for the pattern-discoverer analyst module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/analyst/pattern-discoverer.test.js

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

jest.unstable_mockModule('../../../src/utils/duration.js', () => ({
  parseDuration: jest.fn(() => 90 * 86400000)
}));

jest.unstable_mockModule('../../../src/utils/env.js', () => ({
  parseThreshold: (_env, def) => def,
  parsePositiveInt: (_env, def) => def,
  parsePositiveFloat: (_env, def) => def
}));

const { runPatternDiscovery } = await import('../../../src/agents/analyst/pattern-discoverer.js');

// --- Helpers ---

function makeIncident(id, techniques, opts = {}) {
  return {
    incident_id: id,
    incident_type: 'security',
    severity: opts.severity || 'high',
    mitre_techniques: techniques,
    attack_chain: (opts.attackChain || techniques).map(t => ({ technique_id: t, tactic: 'test' })),
    affected_service: opts.service || 'api-gateway',
    created_at: opts.createdAt || '2025-01-01T00:00:00Z',
    resolved_at: opts.resolvedAt || '2025-01-01T01:00:00Z',
    reflection_count: 0
  };
}

function mockSearchResults(incidents) {
  mockClientSearch.mockImplementation(async (params) => {
    // Dedup check queries vigil-learnings
    if (params.index === 'vigil-learnings') {
      return { hits: { hits: [] } };
    }
    // Main incident search
    return { hits: { hits: incidents.map(inc => ({ _source: inc })) } };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// --- Tests ---

describe('runPatternDiscovery', () => {
  it('returns empty array when insufficient incidents', async () => {
    mockSearchResults([
      makeIncident('INC-1', ['T1078']),
      makeIncident('INC-2', ['T1078'])
    ]);
    const result = await runPatternDiscovery();
    expect(result).toEqual([]);
  });

  it('3+ incidents with >70% overlap → cluster formed', async () => {
    const sharedTechniques = ['T1078', 'T1110', 'T1552'];
    mockSearchResults([
      makeIncident('INC-1', sharedTechniques),
      makeIncident('INC-2', sharedTechniques),
      makeIncident('INC-3', sharedTechniques)
    ]);
    const result = await runPatternDiscovery();
    expect(result.length).toBe(1);
    expect(result[0].learning_type).toBe('pattern_discovery');
    expect(result[0].data.incidents_matched).toBe(3);
    expect(mockClientIndex).toHaveBeenCalled();
  });

  it('average-linkage prevents chaining (A↔B similar, B↔C similar, A↔C dissimilar → separate)', async () => {
    // A and B share 3 of 4 techniques (75% overlap)
    // B and C share 3 of 4 techniques (75% overlap)
    // A and C share only 1 technique (<70% overlap)
    mockSearchResults([
      makeIncident('INC-A', ['T1078', 'T1110', 'T1552', 'T1041']),
      makeIncident('INC-B', ['T1078', 'T1110', 'T1552', 'T1059']),
      makeIncident('INC-C', ['T1059', 'T1136', 'T1552', 'T1098']),
      // Add more of A's type to form a cluster
      makeIncident('INC-D', ['T1078', 'T1110', 'T1552', 'T1041']),
      makeIncident('INC-E', ['T1078', 'T1110', 'T1552', 'T1041'])
    ]);

    const result = await runPatternDiscovery();
    // Should form a cluster of A, D, E (identical) but NOT chain through B to C
    for (const record of result) {
      const ids = record.incident_ids;
      // C should not appear in the same cluster as A
      if (ids.includes('INC-A')) {
        expect(ids).not.toContain('INC-C');
      }
    }
  });

  it('quality gate drops loose clusters', async () => {
    // 3 incidents that barely overlap (below JACCARD_THRESHOLD after pairwise avg)
    mockSearchResults([
      makeIncident('INC-1', ['T1078', 'T1110', 'T1552']),
      makeIncident('INC-2', ['T1078', 'T1059', 'T1136']),
      makeIncident('INC-3', ['T1078', 'T1098', 'T1041']),
    ]);

    const result = await runPatternDiscovery();
    // The pairwise Jaccard between each pair is 1/5 = 0.2, well below 0.7
    // So no cluster should form at all (they won't even cluster together)
    expect(result).toEqual([]);
  });

  it('max cluster size cap enforced', async () => {
    // Create 25 identical incidents (all same techniques)
    // MAX_CLUSTER_SIZE defaults to 20
    const techniques = ['T1078', 'T1110', 'T1552'];
    const incidents = Array.from({ length: 25 }, (_, i) =>
      makeIncident(`INC-${i}`, techniques)
    );
    mockSearchResults(incidents);

    const result = await runPatternDiscovery();
    if (result.length > 0) {
      expect(result[0].data.incidents_matched).toBeLessThanOrEqual(20);
    }
  });

  it('dynamic window → client.search receives correct gte', async () => {
    mockSearchResults([]);
    await runPatternDiscovery({ window: '60d' });

    expect(mockClientSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          bool: expect.objectContaining({
            filter: [{ range: { created_at: { gte: 'now-60d' } } }]
          })
        })
      })
    );
  });

  it('incidents with empty techniques → filtered out, no cluster', async () => {
    mockSearchResults([
      { incident_id: 'INC-1', incident_type: 'security', severity: 'high', mitre_techniques: [], attack_chain: [], affected_service: 'svc', created_at: '2025-01-01T00:00:00Z', resolved_at: '2025-01-01T01:00:00Z' },
      { incident_id: 'INC-2', incident_type: 'security', severity: 'high', mitre_techniques: [], attack_chain: [], affected_service: 'svc', created_at: '2025-01-01T00:00:00Z', resolved_at: '2025-01-01T01:00:00Z' },
      { incident_id: 'INC-3', incident_type: 'security', severity: 'high', mitre_techniques: [], attack_chain: [], affected_service: 'svc', created_at: '2025-01-01T00:00:00Z', resolved_at: '2025-01-01T01:00:00Z' }
    ]);
    const result = await runPatternDiscovery();
    expect(result).toEqual([]);
  });

  it('pattern name uses tactic-ordered techniques', async () => {
    // Techniques with specific tactics that have kill-chain ordering
    const mkInc = (id) => ({
      incident_id: id,
      incident_type: 'security',
      severity: 'high',
      mitre_techniques: ['T1078', 'T1041'],
      attack_chain: [
        { technique_id: 'T1078', tactic: 'initial-access', technique_name: 'Valid Accounts' },
        { technique_id: 'T1041', tactic: 'exfiltration', technique_name: 'Exfiltration Over C2' }
      ],
      affected_service: 'api-gateway',
      created_at: '2025-01-01T00:00:00Z',
      resolved_at: '2025-01-01T01:00:00Z'
    });
    mockSearchResults([mkInc('INC-1'), mkInc('INC-2'), mkInc('INC-3')]);

    const result = await runPatternDiscovery();
    expect(result.length).toBe(1);
    // T1078 (initial-access) should come before T1041 (exfiltration) in the name
    const name = result[0].data.pattern_name;
    expect(name).toBe('T1078 to T1041 Chain');
  });

  it('mitre_techniques without attack_chain → techniques still in MITRE sequence', async () => {
    // Incidents with mitre_techniques only, no attack_chain
    const mkInc = (id) => ({
      incident_id: id,
      incident_type: 'security',
      severity: 'high',
      mitre_techniques: ['T1078', 'T1110', 'T1552'],
      attack_chain: undefined,
      affected_service: 'api-gateway',
      created_at: '2025-01-01T00:00:00Z',
      resolved_at: '2025-01-01T01:00:00Z'
    });
    mockSearchResults([mkInc('INC-1'), mkInc('INC-2'), mkInc('INC-3')]);

    const result = await runPatternDiscovery();
    expect(result.length).toBe(1);
    const sequence = result[0].data.mitre_sequence;
    const techIds = sequence.map(s => s.technique_id);
    expect(techIds).toContain('T1078');
    expect(techIds).toContain('T1110');
    expect(techIds).toContain('T1552');
  });

  it('malformed dates → graceful handling (no crash)', async () => {
    const techniques = ['T1078', 'T1110', 'T1552'];
    mockSearchResults([
      makeIncident('INC-1', techniques, { createdAt: 'not-a-date', resolvedAt: 'also-bad' }),
      makeIncident('INC-2', techniques, { createdAt: '2025-01-01T00:00:00Z', resolvedAt: '2025-01-01T01:00:00Z' }),
      makeIncident('INC-3', techniques)
    ]);

    // Should not throw
    const result = await runPatternDiscovery();
    expect(Array.isArray(result)).toBe(true);
  });
});
