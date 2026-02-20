import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Environment variables (must be set before import) ──────
process.env.KIBANA_URL = 'http://localhost:5601';
process.env.ELASTIC_API_KEY = 'test-api-key';

// ─── Mock setup ─────────────────────────────────────────────

const mockGetAgentCard = mock.fn();
const mockClearCache = mock.fn();

class MockAgentUnavailableError extends Error {
  constructor(agentId, reason, statusCode) {
    super(`Agent '${agentId}' is unavailable: ${reason}`);
    this.name = 'AgentUnavailableError';
    this.agentId = agentId;
    this.statusCode = statusCode ?? null;
  }
}

mock.module(import.meta.resolve('../../../src/a2a/agent-cards.js'), {
  namedExports: {
    getAgentCard: mockGetAgentCard,
    clearCache: mockClearCache,
    AgentUnavailableError: MockAgentUnavailableError
  }
});

mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    })
  }
});

// ─── Import module under test (after mocks are registered) ──

const {
  discoverAllAgents,
  resolveAgentEndpoint,
  checkAgentHealth,
  refreshAgentCache,
  resolveAgentCapabilities,
  getLastDiscovery,
  discoveryEvents,
  VIGIL_AGENTS,
  _resetState
} = await import('../../../src/a2a/discovery.js');

// ─── Helpers ────────────────────────────────────────────────

function fakeCard(agentId, overrides = {}) {
  return {
    agent_id: agentId,
    name: agentId,
    description: `${agentId} agent`,
    version: '1.0.0',
    capabilities: ['investigate', 'triage'],
    endpoint: `/api/agent_builder/a2a/${agentId}`,
    ...overrides
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('discoverAllAgents', () => {
  beforeEach(() => {
    mockGetAgentCard.mock.resetCalls();
    mockClearCache.mock.resetCalls();
    _resetState();

    // Default: all agents succeed
    mockGetAgentCard.mock.mockImplementation(async (agentId) => fakeCard(agentId));
  });

  it('returns all agents as available when all card fetches succeed', async () => {
    const result = await discoverAllAgents();
    assert.equal(result.available.length, VIGIL_AGENTS.length);
    assert.equal(result.unavailable.length, 0);
  });

  it('returns mix of available/unavailable when some fail', async () => {
    let callCount = 0;
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      callCount++;
      if (callCount <= 3) return fakeCard(agentId);
      throw new MockAgentUnavailableError(agentId, 'not found');
    });

    const result = await discoverAllAgents();
    assert.equal(result.available.length, 3);
    assert.equal(result.unavailable.length, VIGIL_AGENTS.length - 3);
  });

  it('returns all unavailable when all fail (never throws)', async () => {
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      throw new MockAgentUnavailableError(agentId, 'down');
    });

    const result = await discoverAllAgents();
    assert.equal(result.available.length, 0);
    assert.equal(result.unavailable.length, VIGIL_AGENTS.length);
  });

  it('accepts custom agent list parameter (R4)', async () => {
    const custom = ['agent-a', 'agent-b'];
    const result = await discoverAllAgents(custom);
    assert.equal(result.available.length, 2);
    assert.equal(mockGetAgentCard.mock.callCount(), 2);
  });

  it('retries transient failures before marking unavailable (S2)', async () => {
    let attempt = 0;
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      attempt++;
      if (attempt <= 2) {
        // Throw AgentUnavailableError with statusCode — matches real agent-cards.js behavior
        const err = new MockAgentUnavailableError(agentId, 'Service Unavailable');
        err.statusCode = 503;
        throw err;
      }
      return fakeCard(agentId);
    });

    // Only discover one agent to isolate retry behavior
    const result = await discoverAllAgents(['test-agent']);
    assert.equal(result.available.length, 1);
    assert.equal(attempt, 3); // 2 retries + 1 success
  });

  it('does not retry non-retryable errors (e.g. 404)', async () => {
    let attempt = 0;
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      attempt++;
      const err = new MockAgentUnavailableError(agentId, 'not found');
      err.statusCode = 404;
      throw err;
    });

    const result = await discoverAllAgents(['test-agent']);
    assert.equal(result.available.length, 0);
    assert.equal(result.unavailable.length, 1);
    assert.equal(attempt, 1); // no retry for 404
  });

  it('emits agent:down when agent transitions from up to down (S5)', async () => {
    // First discovery — all up
    await discoverAllAgents(['agent-a']);

    const downEvents = [];
    discoveryEvents.on('agent:down', (id, reason) => downEvents.push({ id, reason }));

    // Second discovery — agent-a fails
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      throw new MockAgentUnavailableError(agentId, 'connection refused');
    });
    await discoverAllAgents(['agent-a']);

    assert.equal(downEvents.length, 1);
    assert.equal(downEvents[0].id, 'agent-a');
  });

  it('emits agent:up when agent transitions from down to up (S5)', async () => {
    // First discovery — all down
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      throw new MockAgentUnavailableError(agentId, 'down');
    });
    await discoverAllAgents(['agent-a']);

    const upEvents = [];
    discoveryEvents.on('agent:up', (id, card) => upEvents.push({ id, card }));

    // Second discovery — agent-a back up
    mockGetAgentCard.mock.mockImplementation(async (agentId) => fakeCard(agentId));
    await discoverAllAgents(['agent-a']);

    assert.equal(upEvents.length, 1);
    assert.equal(upEvents[0].id, 'agent-a');
  });

  it('stores results in lastDiscovery cache (S3)', async () => {
    assert.equal(getLastDiscovery(), null);
    await discoverAllAgents(['agent-a']);
    const last = getLastDiscovery();
    assert.notEqual(last, null);
    assert.equal(last.results.available.length, 1);
    assert.equal(last.stale, false);
  });
});

// ─── resolveAgentEndpoint ───────────────────────────────────

describe('resolveAgentEndpoint', () => {
  beforeEach(() => {
    mockGetAgentCard.mock.resetCalls();
    _resetState();
  });

  it('returns full URL (KIBANA_URL + card.endpoint) for valid card', async () => {
    mockGetAgentCard.mock.mockImplementation(async () =>
      fakeCard('vigil-triage')
    );
    const url = await resolveAgentEndpoint('vigil-triage');
    assert.equal(url, 'http://localhost:5601/api/agent_builder/a2a/vigil-triage');
  });

  it('throws AgentUnavailableError when card has no endpoint field', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => ({
      agent_id: 'vigil-triage',
      name: 'vigil-triage'
      // no endpoint field
    }));
    await assert.rejects(
      () => resolveAgentEndpoint('vigil-triage'),
      (err) => {
        assert.equal(err.name, 'AgentUnavailableError');
        assert.ok(err.message.includes('endpoint'));
        return true;
      }
    );
  });

  it('throws AgentUnavailableError when getAgentCard fails', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => {
      throw new MockAgentUnavailableError('vigil-triage', 'not found');
    });
    await assert.rejects(
      () => resolveAgentEndpoint('vigil-triage'),
      (err) => {
        assert.equal(err.name, 'AgentUnavailableError');
        return true;
      }
    );
  });
});

// ─── checkAgentHealth ───────────────────────────────────────

describe('checkAgentHealth', () => {
  beforeEach(() => {
    mockGetAgentCard.mock.resetCalls();
    _resetState();
  });

  it('returns healthy with latencyMs on success (S1)', async () => {
    mockGetAgentCard.mock.mockImplementation(async () =>
      fakeCard('vigil-triage', { version: '2.1.0', capabilities: ['triage'] })
    );
    const health = await checkAgentHealth('vigil-triage');
    assert.equal(health.healthy, true);
    assert.equal(health.agentId, 'vigil-triage');
    assert.equal(typeof health.latencyMs, 'number');
    assert.ok(health.latencyMs >= 0);
    assert.equal(health.version, '2.1.0');
    assert.deepEqual(health.capabilities, ['triage']);
    assert.equal(typeof health.lastChecked, 'string');
  });

  it('returns unhealthy with error on failure — never throws', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => {
      throw new MockAgentUnavailableError('vigil-triage', 'timeout');
    });
    const health = await checkAgentHealth('vigil-triage');
    assert.equal(health.healthy, false);
    assert.equal(health.agentId, 'vigil-triage');
    assert.equal(typeof health.error, 'string');
    assert.ok(health.error.includes('timeout'));
  });

  it('latencyMs is a non-negative number even on failure', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => {
      throw new Error('fail');
    });
    const health = await checkAgentHealth('vigil-triage');
    assert.equal(typeof health.latencyMs, 'number');
    assert.ok(health.latencyMs >= 0);
  });
});

// ─── refreshAgentCache ──────────────────────────────────────

describe('refreshAgentCache', () => {
  beforeEach(() => {
    mockGetAgentCard.mock.resetCalls();
    mockClearCache.mock.resetCalls();
    _resetState();
    mockGetAgentCard.mock.mockImplementation(async (agentId) => fakeCard(agentId));
  });

  it('calls clearCache() then discoverAllAgents()', async () => {
    const result = await refreshAgentCache();
    assert.equal(mockClearCache.mock.callCount(), 1);
    assert.equal(typeof result.available, 'number');
    assert.equal(typeof result.unavailable, 'number');
  });

  it('returns available and unavailable counts', async () => {
    const result = await refreshAgentCache();
    assert.equal(result.available, VIGIL_AGENTS.length);
    assert.equal(result.unavailable, 0);
  });

  it('concurrent calls return stale results instead of double-refreshing (R5)', async () => {
    // First call to seed lastDiscovery
    await refreshAgentCache();
    mockClearCache.mock.resetCalls();

    // Slow down getAgentCard to create a window for concurrency
    mockGetAgentCard.mock.mockImplementation(async (agentId) => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeCard(agentId);
    });

    // Fire two concurrent refreshes
    const [r1, r2] = await Promise.all([
      refreshAgentCache(),
      refreshAgentCache()
    ]);

    // clearCache should only be called once (second call hits refreshLock)
    assert.equal(mockClearCache.mock.callCount(), 1);
    assert.equal(typeof r1.available, 'number');
    assert.equal(typeof r2.available, 'number');
  });
});

// ─── resolveAgentCapabilities ───────────────────────────────

describe('resolveAgentCapabilities', () => {
  beforeEach(() => {
    mockGetAgentCard.mock.resetCalls();
    _resetState();
  });

  it('returns full capabilities array for agent (S4)', async () => {
    mockGetAgentCard.mock.mockImplementation(async () =>
      fakeCard('vigil-triage', { capabilities: ['triage', 'enrich'] })
    );
    const caps = await resolveAgentCapabilities('vigil-triage');
    assert.deepEqual(caps, ['triage', 'enrich']);
  });

  it('returns matching capability when taskName filter provided', async () => {
    mockGetAgentCard.mock.mockImplementation(async () =>
      fakeCard('vigil-triage', {
        capabilities: [
          { task: 'triage', description: 'Triage alerts' },
          { task: 'enrich', description: 'Enrich context' }
        ]
      })
    );
    const cap = await resolveAgentCapabilities('vigil-triage', 'enrich');
    assert.deepEqual(cap, { task: 'enrich', description: 'Enrich context' });
  });

  it('throws when agent does not support requested task', async () => {
    mockGetAgentCard.mock.mockImplementation(async () =>
      fakeCard('vigil-triage', { capabilities: ['triage'] })
    );
    await assert.rejects(
      () => resolveAgentCapabilities('vigil-triage', 'not-supported'),
      (err) => {
        assert.equal(err.name, 'AgentUnavailableError');
        assert.ok(err.message.includes('not-supported'));
        return true;
      }
    );
  });
});

// ─── getLastDiscovery ───────────────────────────────────────

describe('getLastDiscovery', () => {
  beforeEach(() => {
    mockGetAgentCard.mock.resetCalls();
    _resetState();
    mockGetAgentCard.mock.mockImplementation(async (agentId) => fakeCard(agentId));
  });

  it('returns null before first discovery', () => {
    const result = getLastDiscovery();
    assert.equal(result, null);
  });

  it('returns results with stale: false immediately after discovery', async () => {
    await discoverAllAgents(['agent-a']);
    const last = getLastDiscovery();
    assert.equal(last.stale, false);
    assert.equal(last.results.available.length, 1);
    assert.equal(typeof last.timestamp, 'number');
  });

  it('returns results with stale: true after TTL expires', async () => {
    await discoverAllAgents(['agent-a']);

    // Mock Date.now to simulate TTL expiry (>5 minutes in the future)
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 6 * 60 * 1000; // 6 minutes ahead
      const last = getLastDiscovery();
      assert.equal(last.stale, true);
    } finally {
      Date.now = originalNow;
    }
  });

  it('returns a deep clone — mutations do not affect internal state', async () => {
    await discoverAllAgents(['agent-a']);
    const first = getLastDiscovery();
    first.results.available.push({ agent_id: 'injected' });
    const second = getLastDiscovery();
    assert.equal(second.results.available.length, 1, 'internal state should not be mutated');
  });
});

// ─── VIGIL_AGENTS ───────────────────────────────────────────

describe('VIGIL_AGENTS', () => {
  it('is a frozen array with 8 known agents', () => {
    assert.equal(Object.isFrozen(VIGIL_AGENTS), true);
    assert.equal(VIGIL_AGENTS.length, 8);
    assert.ok(VIGIL_AGENTS.includes('vigil-triage'));
    assert.ok(VIGIL_AGENTS.includes('vigil-commander'));
  });
});
