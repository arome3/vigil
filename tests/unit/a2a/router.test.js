import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Environment variables (must be set before import) ──────
process.env.KIBANA_URL = 'http://localhost:5601';
process.env.ELASTIC_API_KEY = 'test-api-key';

// ─── Mock setup ─────────────────────────────────────────────

const mockPost = mock.fn();
const mockGetAgentCard = mock.fn();
const mockClientIndex = mock.fn();

class MockAgentUnavailableError extends Error {
  constructor(agentId, reason) {
    super(`Agent '${agentId}' is unavailable: ${reason}`);
    this.name = 'AgentUnavailableError';
    this.agentId = agentId;
  }
}

mock.module('axios', {
  defaultExport: { post: mockPost }
});

mock.module(import.meta.resolve('../../../src/a2a/agent-cards.js'), {
  namedExports: {
    getAgentCard: mockGetAgentCard,
    AgentUnavailableError: MockAgentUnavailableError
  }
});

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: { index: mockClientIndex }
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

const { sendA2AMessage, A2A_TIMEOUTS, AgentTimeoutError, A2AError } =
  await import('../../../src/a2a/router.js');

// ─── Helpers ────────────────────────────────────────────────

function validEnvelope(overrides = {}) {
  return {
    message_id: 'msg-test-001',
    from_agent: 'vigil-coordinator',
    to_agent: 'vigil-triage',
    timestamp: new Date().toISOString(),
    correlation_id: 'corr-001',
    payload: { task: 'enrich_and_score' },
    ...overrides
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('sendA2AMessage', () => {
  beforeEach(() => {
    mockPost.mock.resetCalls();
    mockGetAgentCard.mock.resetCalls();
    mockClientIndex.mock.resetCalls();

    // Default happy-path mocks
    mockGetAgentCard.mock.mockImplementation(async () => ({
      name: 'vigil-triage',
      url: 'http://localhost:5601/api/agent_builder/a2a/vigil-triage'
    }));
    mockPost.mock.mockImplementation(async () => ({ data: { result: 'ok' } }));
    mockClientIndex.mock.mockImplementation(async () => ({}));
  });

  it('validates envelope before sending', async () => {
    const badEnvelope = { message_id: 'x' }; // missing required fields
    await assert.rejects(
      () => sendA2AMessage('vigil-triage', badEnvelope),
      (err) => {
        assert.equal(err.name, 'EnvelopeValidationError');
        return true;
      }
    );
    // Should not have attempted to send
    assert.equal(mockPost.mock.callCount(), 0);
  });

  it('fetches agent card before sending', async () => {
    await sendA2AMessage('vigil-triage', validEnvelope());
    assert.equal(mockGetAgentCard.mock.callCount(), 1);
    assert.equal(mockGetAgentCard.mock.calls[0].arguments[0], 'vigil-triage');
  });

  it('uses per-agent timeout from A2A_TIMEOUTS', async () => {
    await sendA2AMessage('vigil-triage', validEnvelope());
    const postCallArgs = mockPost.mock.calls[0].arguments;
    const config = postCallArgs[2]; // axios config object
    assert.equal(config.timeout, A2A_TIMEOUTS['vigil-triage']);
  });

  it('uses default 60s timeout for unknown agents', async () => {
    await sendA2AMessage('vigil-unknown-agent', validEnvelope());
    const config = mockPost.mock.calls[0].arguments[2];
    assert.equal(config.timeout, 60_000);
  });

  it('throws AgentTimeoutError on ECONNABORTED', async () => {
    const err = new Error('timeout');
    err.code = 'ECONNABORTED';
    mockPost.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(
      () => sendA2AMessage('vigil-triage', validEnvelope()),
      (thrown) => {
        assert.equal(thrown.name, 'AgentTimeoutError');
        assert.equal(thrown.agentId, 'vigil-triage');
        assert.equal(thrown.timeoutMs, A2A_TIMEOUTS['vigil-triage']);
        return true;
      }
    );
  });

  it('throws A2AError on non-timeout failures', async () => {
    const err = new Error('Server error');
    err.response = { status: 500, data: { message: 'Internal failure' } };
    mockPost.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(
      () => sendA2AMessage('vigil-triage', validEnvelope()),
      (thrown) => {
        assert.equal(thrown.name, 'A2AError');
        assert.equal(thrown.agentId, 'vigil-triage');
        assert.equal(thrown.statusCode, 500);
        return true;
      }
    );
  });

  it('logs telemetry to vigil-agent-telemetry on success', async () => {
    await sendA2AMessage('vigil-triage', validEnvelope());
    assert.equal(mockClientIndex.mock.callCount(), 1);
    const indexCall = mockClientIndex.mock.calls[0].arguments[0];
    assert.equal(indexCall.index, 'vigil-agent-telemetry');
    assert.equal(indexCall.document.agent_name, 'vigil-triage');
    assert.equal(indexCall.document.status, 'success');
  });

  it('logs telemetry on error', async () => {
    const err = new Error('fail');
    err.response = { status: 503, data: {} };
    mockPost.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(() => sendA2AMessage('vigil-triage', validEnvelope()));
    assert.equal(mockClientIndex.mock.callCount(), 1);
    const doc = mockClientIndex.mock.calls[0].arguments[0].document;
    assert.equal(doc.status, 'error');
  });

  it('telemetry includes execution_time_ms', async () => {
    await sendA2AMessage('vigil-triage', validEnvelope());
    const doc = mockClientIndex.mock.calls[0].arguments[0].document;
    assert.equal(typeof doc.execution_time_ms, 'number');
    assert.ok(doc.execution_time_ms >= 0);
  });

  // ── ETIMEDOUT triggers AgentTimeoutError (F4) ──

  it('throws AgentTimeoutError on ETIMEDOUT', async () => {
    const err = new Error('connect ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    mockPost.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(
      () => sendA2AMessage('vigil-triage', validEnvelope()),
      (thrown) => {
        assert.equal(thrown.name, 'AgentTimeoutError');
        assert.equal(thrown.agentId, 'vigil-triage');
        assert.equal(thrown.timeoutMs, A2A_TIMEOUTS['vigil-triage']);
        return true;
      }
    );
  });

  // ── getAgentCard failure propagates as-is (F5) ──

  it('propagates AgentUnavailableError when getAgentCard fails', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => {
      throw new MockAgentUnavailableError('vigil-triage', 'not found');
    });

    await assert.rejects(
      () => sendA2AMessage('vigil-triage', validEnvelope()),
      (thrown) => {
        assert.equal(thrown.name, 'AgentUnavailableError');
        assert.equal(thrown.agentId, 'vigil-triage');
        return true;
      }
    );
    // axios.post should never be called
    assert.equal(mockPost.mock.callCount(), 0);
  });

  // ── options.timeout overrides per-agent timeout (F6) ──

  it('uses options.timeout when provided', async () => {
    await sendA2AMessage('vigil-triage', validEnvelope(), { timeout: 5000 });
    const config = mockPost.mock.calls[0].arguments[2];
    assert.equal(config.timeout, 5000);
  });

  // ── Telemetry failure does not prevent response (F7) ──

  it('returns response even when telemetry indexing fails', async () => {
    mockClientIndex.mock.mockImplementation(async () => {
      throw new Error('ES cluster unavailable');
    });

    const result = await sendA2AMessage('vigil-triage', validEnvelope());
    assert.deepEqual(result, { result: 'ok' });
  });

  // ── Returns resp.data on success (F8) ──

  it('returns resp.data on success', async () => {
    mockPost.mock.mockImplementation(async () => ({
      data: { incident_id: 'inc-1', status: 'completed' }
    }));

    const result = await sendA2AMessage('vigil-triage', validEnvelope());
    assert.deepEqual(result, { incident_id: 'inc-1', status: 'completed' });
  });

  // ── Telemetry records timeout status (not just error) ──

  it('telemetry records timeout status on ECONNABORTED', async () => {
    const err = new Error('timeout');
    err.code = 'ECONNABORTED';
    mockPost.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(() => sendA2AMessage('vigil-triage', validEnvelope()));
    const doc = mockClientIndex.mock.calls[0].arguments[0].document;
    assert.equal(doc.status, 'timeout');
  });

  // ── Card failure records telemetry with card_unavailable status ──

  it('records card_unavailable telemetry when getAgentCard fails', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => {
      throw new MockAgentUnavailableError('vigil-triage', 'not found');
    });

    await assert.rejects(() => sendA2AMessage('vigil-triage', validEnvelope()));
    assert.equal(mockClientIndex.mock.callCount(), 1);
    const doc = mockClientIndex.mock.calls[0].arguments[0].document;
    assert.equal(doc.status, 'card_unavailable');
    assert.equal(typeof doc.execution_time_ms, 'number');
    assert.ok(doc.execution_time_ms >= 0);
  });

  // ── Capability check rejects unsupported tasks ──

  it('throws A2AError when agent does not support the task', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => ({
      name: 'vigil-triage',
      capabilities: ['enrich_and_score']
    }));

    const envelope = validEnvelope({ payload: { task: 'unsupported_task' } });
    await assert.rejects(
      () => sendA2AMessage('vigil-triage', envelope),
      (thrown) => {
        assert.equal(thrown.name, 'A2AError');
        assert.ok(thrown.message.includes('unsupported_task'));
        return true;
      }
    );
    assert.equal(mockPost.mock.callCount(), 0);
  });

  it('allows task when card has no capabilities (backward compat)', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => ({
      name: 'vigil-triage'
      // no capabilities field
    }));

    const result = await sendA2AMessage('vigil-triage', validEnvelope());
    assert.deepEqual(result, { result: 'ok' });
  });

  it('allows task when it matches a capability', async () => {
    mockGetAgentCard.mock.mockImplementation(async () => ({
      name: 'vigil-triage',
      capabilities: ['enrich_and_score', 'triage']
    }));

    const result = await sendA2AMessage('vigil-triage', validEnvelope());
    assert.deepEqual(result, { result: 'ok' });
  });

  // ── Retry on transient HTTP failure ──

  it('retries once on transient 503 before succeeding', async () => {
    let attempt = 0;
    mockPost.mock.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('Service Unavailable');
        err.response = { status: 503, data: {} };
        throw err;
      }
      return { data: { result: 'ok-after-retry' } };
    });

    const result = await sendA2AMessage('vigil-triage', validEnvelope());
    assert.deepEqual(result, { result: 'ok-after-retry' });
    assert.equal(attempt, 2);
  });

  it('does not retry on 4xx errors', async () => {
    let attempt = 0;
    mockPost.mock.mockImplementation(async () => {
      attempt++;
      const err = new Error('Bad Request');
      err.response = { status: 400, data: { message: 'Invalid payload' } };
      throw err;
    });

    await assert.rejects(
      () => sendA2AMessage('vigil-triage', validEnvelope()),
      (thrown) => {
        assert.equal(thrown.name, 'A2AError');
        assert.equal(thrown.statusCode, 400);
        return true;
      }
    );
    assert.equal(attempt, 1); // no retry
  });
});

// ─── Error class shapes (T4) ────────────────────────────────

describe('AgentTimeoutError', () => {
  it('has name, agentId, and timeoutMs properties', () => {
    const err = new AgentTimeoutError('vigil-triage', 10000);
    assert.equal(err.name, 'AgentTimeoutError');
    assert.equal(err.agentId, 'vigil-triage');
    assert.equal(err.timeoutMs, 10000);
    assert.ok(err.message.includes('vigil-triage'));
    assert.ok(err.message.includes('10000'));
  });

  it('is an instance of Error', () => {
    const err = new AgentTimeoutError('x', 1000);
    assert.ok(err instanceof Error);
  });
});

describe('A2AError', () => {
  it('has name, agentId, and statusCode properties', () => {
    const err = new A2AError('vigil-triage', 'Internal failure', 500);
    assert.equal(err.name, 'A2AError');
    assert.equal(err.agentId, 'vigil-triage');
    assert.equal(err.statusCode, 500);
    assert.ok(err.message.includes('vigil-triage'));
    assert.ok(err.message.includes('Internal failure'));
  });

  it('is an instance of Error', () => {
    const err = new A2AError('x', 'fail', 503);
    assert.ok(err instanceof Error);
  });
});

describe('A2A_TIMEOUTS', () => {
  it('has entries for all 7 spoke agents plus 6 workflows', () => {
    const expectedAgents = [
      'vigil-triage', 'vigil-investigator', 'vigil-threat-hunter',
      'vigil-sentinel', 'vigil-commander', 'vigil-executor', 'vigil-verifier'
    ];
    const expectedWorkflows = [
      'vigil-wf-containment', 'vigil-wf-remediation', 'vigil-wf-notify',
      'vigil-wf-ticketing', 'vigil-wf-approval', 'vigil-wf-reporting'
    ];

    for (const agent of [...expectedAgents, ...expectedWorkflows]) {
      assert.ok(A2A_TIMEOUTS[agent] !== undefined, `Missing timeout for ${agent}`);
      assert.equal(typeof A2A_TIMEOUTS[agent], 'number');
    }

    assert.equal(Object.keys(A2A_TIMEOUTS).length, 13);
  });
});
