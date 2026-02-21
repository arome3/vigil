import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════
// Mock functions
// ═══════════════════════════════════════════════════════════════

const mockOrchestrateSecurity = mock.fn();
const mockOrchestrateOperational = mock.fn();
const mockBuildTriageRequest = mock.fn((source) => ({ task: 'enrich_and_score', alert: source }));
const mockValidateTriageResponse = mock.fn();
const mockSendA2AMessage = mock.fn();
const mockCreateEnvelope = mock.fn((_from, _to, _corr, payload) => ({
  message_id: 'msg-test', from_agent: _from, to_agent: _to,
  timestamp: '2026-02-20T10:00:00.000Z', correlation_id: _corr, payload
}));
const mockClientSearch = mock.fn();
const mockClientUpdate = mock.fn();
const mockClientIndex = mock.fn();

// ═══════════════════════════════════════════════════════════════
// Register mocks before importing module under test
// ═══════════════════════════════════════════════════════════════

mock.module(import.meta.resolve('../../../src/agents/coordinator/delegation.js'), {
  namedExports: {
    orchestrateSecurityIncident: mockOrchestrateSecurity,
    orchestrateOperationalIncident: mockOrchestrateOperational
  }
});

mock.module(import.meta.resolve('../../../src/a2a/contracts.js'), {
  namedExports: {
    buildTriageRequest: mockBuildTriageRequest,
    validateTriageResponse: mockValidateTriageResponse
  }
});

mock.module(import.meta.resolve('../../../src/a2a/router.js'), {
  namedExports: { sendA2AMessage: mockSendA2AMessage }
});

mock.module(import.meta.resolve('../../../src/a2a/message-envelope.js'), {
  namedExports: { createEnvelope: mockCreateEnvelope }
});

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: {
    search: mockClientSearch,
    update: mockClientUpdate,
    index: mockClientIndex
  }
});

mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}
    })
  }
});

mock.module(import.meta.resolve('../../../src/utils/env.js'), {
  namedExports: {
    parsePositiveInt: (_name, def) => def
  }
});

// ═══════════════════════════════════════════════════════════════
// Import module under test
// ═══════════════════════════════════════════════════════════════

const {
  determineIncidentType,
  processAlert,
  startAlertWatcher,
  stopAlertWatcher
} = await import('../../../src/agents/coordinator/alert-watcher.js');

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

function makeAlertHit(overrides = {}) {
  return {
    _id: 'alert-001',
    _seq_no: 1,
    _primary_term: 1,
    _source: {
      alert_id: 'ALERT-001',
      rule_id: 'rule-123',
      severity_original: 'high',
      source_ip: '10.0.0.5',
      source_user: 'jdoe',
      affected_asset_id: 'web-1',
      timestamp: '2026-02-20T10:00:00.000Z'
    },
    ...overrides
  };
}

function makeTriageResponse(overrides = {}) {
  return {
    alert_id: 'ALERT-001',
    priority_score: 0.87,
    disposition: 'investigate',
    enrichment: {
      correlated_event_count: 5, unique_destinations: 3,
      failed_auth_count: 2, risk_signal: 0.8,
      historical_fp_rate: 0.1, asset_criticality: 'tier-1',
      source_ip: '10.0.0.5', source_user: 'jdoe'
    },
    ...overrides
  };
}

function resetAllMocks() {
  for (const fn of [
    mockOrchestrateSecurity, mockOrchestrateOperational,
    mockBuildTriageRequest, mockValidateTriageResponse,
    mockSendA2AMessage, mockCreateEnvelope,
    mockClientSearch, mockClientUpdate, mockClientIndex
  ]) {
    fn.mock.resetCalls();
    fn.mock.restore();
  }
}

function setupDefaultMocks() {
  mockSendA2AMessage.mock.mockImplementation(async () => makeTriageResponse());
  mockOrchestrateSecurity.mock.mockImplementation(async () => ({ status: 'resolved' }));
  mockOrchestrateOperational.mock.mockImplementation(async () => ({ status: 'resolved' }));
  mockClientUpdate.mock.mockImplementation(async () => ({ result: 'updated' }));
  mockClientIndex.mock.mockImplementation(async () => ({ result: 'created' }));
  mockClientSearch.mock.mockImplementation(async () => ({ hits: { hits: [] } }));
}

// ═══════════════════════════════════════════════════════════════
// Tests: determineIncidentType
// ═══════════════════════════════════════════════════════════════

describe('determineIncidentType', () => {
  it('returns operational for sentinel- prefixed rule_id', () => {
    const result = determineIncidentType({ rule_id: 'sentinel-anomaly-123' });
    assert.equal(result, 'operational');
  });

  it('returns operational for ops- prefixed rule_id', () => {
    const result = determineIncidentType({ rule_id: 'ops-cpu-spike' });
    assert.equal(result, 'operational');
  });

  it('returns security for unknown rule_id prefix', () => {
    const result = determineIncidentType({ rule_id: 'siem-brute-force' });
    assert.equal(result, 'security');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: processAlert
// ═══════════════════════════════════════════════════════════════

describe('processAlert', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  it('triages alert via A2A and routes security incident', async () => {
    const hit = makeAlertHit();

    await processAlert(hit);

    // Verify triage A2A call
    assert.equal(mockSendA2AMessage.mock.callCount(), 1);
    const sendCall = mockSendA2AMessage.mock.calls[0];
    assert.equal(sendCall.arguments[0], 'vigil-triage');

    // Verify security routing
    assert.equal(mockOrchestrateSecurity.mock.callCount(), 1);
    assert.equal(mockOrchestrateOperational.mock.callCount(), 0);
  });

  it('routes operational incident for sentinel rule_id', async () => {
    const hit = makeAlertHit({
      _source: {
        ...makeAlertHit()._source,
        rule_id: 'sentinel-anomaly-001'
      }
    });

    await processAlert(hit);

    assert.equal(mockOrchestrateOperational.mock.callCount(), 1);
    assert.equal(mockOrchestrateSecurity.mock.callCount(), 0);
  });

  it('marks alert processed after successful triage', async () => {
    await processAlert(makeAlertHit());

    // First update is markAlertProcessed
    const updateCalls = mockClientUpdate.mock.calls;
    assert.ok(updateCalls.length >= 1);
    const processedCall = updateCalls.find(
      c => c.arguments[0].index === 'vigil-alerts' && c.arguments[0].doc?.processed_at
    );
    assert.ok(processedCall, 'should mark alert as processed');
  });

  it('marks alert failed when triage throws', async () => {
    mockSendA2AMessage.mock.mockImplementation(async () => {
      throw new Error('triage agent unavailable');
    });

    await processAlert(makeAlertHit());

    const updateCalls = mockClientUpdate.mock.calls;
    const errorCall = updateCalls.find(
      c => c.arguments[0].doc?.error
    );
    assert.ok(errorCall, 'should mark alert with error');
    assert.match(errorCall.arguments[0].doc.error, /Triage failed/);
  });

  it('continues when orchestration throws', async () => {
    mockOrchestrateSecurity.mock.mockImplementation(async () => {
      throw new Error('orchestration boom');
    });

    // Should not rethrow
    await assert.doesNotReject(() => processAlert(makeAlertHit()));
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: pollAlerts (via startAlertWatcher + fake timers)
// ═══════════════════════════════════════════════════════════════

describe('pollAlerts', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
    stopAlertWatcher(); // ensure clean state
  });

  it('searches vigil-alerts for unprocessed alerts', async (t) => {
    mockClientSearch.mock.mockImplementation(async () => ({
      hits: { hits: [] }
    }));

    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();

    // Let initial poll fire
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(mockClientSearch.mock.callCount() >= 1);
    const searchCall = mockClientSearch.mock.calls[0];
    assert.equal(searchCall.arguments[0].index, 'vigil-alerts');
    assert.ok(searchCall.arguments[0].query.bool.must_not);

    stopAlertWatcher();
  });

  it('claims alert before processing (deduplication)', async (t) => {
    const hit = makeAlertHit();
    mockClientSearch.mock.mockImplementation(async () => ({
      hits: { hits: [hit] }
    }));

    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();
    await new Promise(resolve => setImmediate(resolve));
    // Let processAlert complete
    await new Promise(resolve => setImmediate(resolve));

    // First update call should be the claim (if_seq_no present)
    const claimCall = mockClientUpdate.mock.calls.find(
      c => c.arguments[0].if_seq_no !== undefined && c.arguments[0].doc?._processing_started_at
    );
    assert.ok(claimCall, 'should claim alert with optimistic concurrency');
    assert.equal(claimCall.arguments[0].if_seq_no, 1);
    assert.equal(claimCall.arguments[0].if_primary_term, 1);

    stopAlertWatcher();
  });

  it('skips alert when claim fails with 409', async (t) => {
    const hit = makeAlertHit();
    mockClientSearch.mock.mockImplementation(async () => ({
      hits: { hits: [hit] }
    }));

    // First update (claim) returns 409
    mockClientUpdate.mock.mockImplementation(async (params) => {
      if (params.if_seq_no !== undefined) {
        const err = new Error('version_conflict_engine_exception');
        err.meta = { statusCode: 409 };
        throw err;
      }
      return { result: 'updated' };
    });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // processAlert should not be called (we verify by checking triage was not triggered)
    assert.equal(mockSendA2AMessage.mock.callCount(), 0);

    stopAlertWatcher();
  });

  it('applies exponential backoff on poll failure', async (t) => {
    let callCount = 0;
    mockClientSearch.mock.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('cluster unavailable');
      return { hits: { hits: [] } };
    });

    // Drain helper — multiple setImmediate to let async chains settle
    const drain = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
    };

    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();

    // First poll fails
    await drain();
    assert.equal(callCount, 1);

    // Tick past first backoff (1000ms)
    t.mock.timers.tick(1000);
    await drain();
    assert.equal(callCount, 2);

    // Second failure doubles backoff to 2000ms
    // Tick 1500ms — should NOT have polled again
    t.mock.timers.tick(1500);
    await drain();
    assert.equal(callCount, 2, 'should not poll before backoff expires');

    // Tick remaining 500ms
    t.mock.timers.tick(500);
    await drain();
    assert.equal(callCount, 3);

    stopAlertWatcher();
  });

  it('triggers circuit breaker after MAX_CONSECUTIVE_FAILURES', async (t) => {
    mockClientSearch.mock.mockImplementation(async () => {
      throw new Error('cluster down');
    });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();

    // Fire 5 failures (default MAX_CONSECUTIVE_FAILURES)
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve));
      // Tick past the backoff for next poll
      t.mock.timers.tick(MAX_BACKOFF_TICK);
    }

    // After circuit breaker, watcher should be stopped
    // Tick a long time — no more polls should fire
    const countBefore = mockClientSearch.mock.callCount();
    t.mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mockClientSearch.mock.callCount(), countBefore,
      'no more polls after circuit breaker');
  });
});

// Max backoff helper for circuit breaker test
const MAX_BACKOFF_TICK = 31_000; // > MAX_BACKOFF_MS (30_000)

// ═══════════════════════════════════════════════════════════════
// Tests: startAlertWatcher / stopAlertWatcher
// ═══════════════════════════════════════════════════════════════

describe('startAlertWatcher / stopAlertWatcher', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
    stopAlertWatcher();
  });

  it('starts polling and fires initial poll', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(mockClientSearch.mock.callCount() >= 1, 'should fire initial poll');

    stopAlertWatcher();
  });

  it('stops polling on stopAlertWatcher', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();
    await new Promise(resolve => setImmediate(resolve));

    const countAfterStart = mockClientSearch.mock.callCount();
    stopAlertWatcher();

    t.mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(mockClientSearch.mock.callCount(), countAfterStart,
      'no more polls after stop');
  });

  it('ignores duplicate start calls', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();
    startAlertWatcher(); // duplicate — should be ignored

    await new Promise(resolve => setImmediate(resolve));

    // Only one initial poll should have fired
    assert.equal(mockClientSearch.mock.callCount(), 1);

    stopAlertWatcher();
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: telemetry
// ═══════════════════════════════════════════════════════════════

describe('telemetry', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
    stopAlertWatcher();
  });

  it('indexes telemetry after successful poll cycle', async (t) => {
    mockClientSearch.mock.mockImplementation(async () => ({
      hits: { hits: [] }
    }));

    t.mock.timers.enable({ apis: ['setTimeout'] });
    startAlertWatcher();
    await new Promise(resolve => setImmediate(resolve));

    const telemetryCalls = mockClientIndex.mock.calls.filter(
      c => c.arguments[0].index === 'vigil-watcher-telemetry'
    );
    assert.ok(telemetryCalls.length >= 1, 'should index telemetry');
    assert.equal(telemetryCalls[0].arguments[0].document.component, 'alert-watcher');

    stopAlertWatcher();
  });

  it('telemetry does not throw on indexing failure', async (t) => {
    mockClientSearch.mock.mockImplementation(async () => ({
      hits: { hits: [] }
    }));
    mockClientIndex.mock.mockImplementation(async () => {
      throw new Error('index write failed');
    });

    t.mock.timers.enable({ apis: ['setTimeout'] });

    // Should not throw
    startAlertWatcher();
    await new Promise(resolve => setImmediate(resolve));

    stopAlertWatcher();
  });
});
