import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock setup ─────────────────────────────────────────────

const mockClientGet = mock.fn();
const mockClientUpdate = mock.fn();
const mockClientIndex = mock.fn();

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: { get: mockClientGet, update: mockClientUpdate, index: mockClientIndex }
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
  VALID_STATES, VALID_TRANSITIONS, transitionIncident, getIncident,
  InvalidTransitionError, ConcurrencyError
} = await import('../../../src/state-machine/transitions.js');

// ─── Helpers ────────────────────────────────────────────────

function createMockIncident(overrides = {}) {
  return {
    incident_id: 'INC-TEST-001',
    status: 'detected',
    incident_type: 'security',
    severity: 'high',
    priority_score: 0.87,
    reflection_count: 0,
    created_at: '2026-02-17T10:30:00.000Z',
    updated_at: '2026-02-17T10:30:00.000Z',
    alert_timestamp: '2026-02-17T10:29:55.000Z',
    _state_timestamps: { detected: '2026-02-17T10:30:00.000Z' },
    resolution_type: null,
    resolved_at: null,
    ...overrides
  };
}

function mockGetReturning(doc) {
  mockClientGet.mock.mockImplementation(async () => ({
    _source: doc,
    _seq_no: 1,
    _primary_term: 1
  }));
}

// ─── Tests ──────────────────────────────────────────────────

beforeEach(() => {
  mockClientGet.mock.resetCalls();
  mockClientUpdate.mock.resetCalls();
  mockClientIndex.mock.resetCalls();

  // Default happy-path mocks
  mockClientGet.mock.mockImplementation(async () => ({
    _source: createMockIncident(),
    _seq_no: 1,
    _primary_term: 1
  }));
  mockClientUpdate.mock.mockImplementation(async () => ({}));
  mockClientIndex.mock.mockImplementation(async () => ({}));
});

// ─── VALID_TRANSITIONS map ──────────────────────────────────

describe('VALID_TRANSITIONS map', () => {
  it('contains exactly 12 states', () => {
    assert.equal(Object.keys(VALID_TRANSITIONS).length, 12);
  });

  it('all VALID_STATES keys present in VALID_TRANSITIONS', () => {
    for (const state of VALID_STATES) {
      assert.ok(
        state in VALID_TRANSITIONS,
        `Missing state '${state}' in VALID_TRANSITIONS`
      );
    }
  });

  it('terminal states resolved and suppressed have empty arrays', () => {
    assert.deepEqual(VALID_TRANSITIONS['resolved'], []);
    assert.deepEqual(VALID_TRANSITIONS['suppressed'], []);
  });

  it('escalated allows only investigating', () => {
    assert.deepEqual(VALID_TRANSITIONS['escalated'], ['investigating']);
  });
});

// ─── transitionIncident — valid transitions ─────────────────

describe('transitionIncident — valid transitions', () => {
  it('detected -> triaged', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    const result = await transitionIncident('INC-TEST-001', 'triaged');
    assert.equal(result.status, 'triaged');
  });

  it('triaged -> investigating', async () => {
    mockGetReturning(createMockIncident({ status: 'triaged' }));
    const result = await transitionIncident('INC-TEST-001', 'investigating');
    assert.equal(result.status, 'investigating');
  });

  it('triaged -> suppressed', async () => {
    mockGetReturning(createMockIncident({ status: 'triaged' }));
    const result = await transitionIncident('INC-TEST-001', 'suppressed');
    assert.equal(result.status, 'suppressed');
  });

  it('investigating -> threat_hunting', async () => {
    mockGetReturning(createMockIncident({ status: 'investigating' }));
    const result = await transitionIncident('INC-TEST-001', 'threat_hunting');
    assert.equal(result.status, 'threat_hunting');
  });

  it('investigating -> planning', async () => {
    mockGetReturning(createMockIncident({ status: 'investigating' }));
    const result = await transitionIncident('INC-TEST-001', 'planning');
    assert.equal(result.status, 'planning');
  });

  it('planning -> awaiting_approval', async () => {
    mockGetReturning(createMockIncident({ status: 'planning' }));
    const result = await transitionIncident('INC-TEST-001', 'awaiting_approval');
    assert.equal(result.status, 'awaiting_approval');
  });

  it('planning -> executing', async () => {
    mockGetReturning(createMockIncident({ status: 'planning' }));
    const result = await transitionIncident('INC-TEST-001', 'executing');
    assert.equal(result.status, 'executing');
  });

  it('awaiting_approval -> executing', async () => {
    mockGetReturning(createMockIncident({ status: 'awaiting_approval' }));
    const result = await transitionIncident('INC-TEST-001', 'executing');
    assert.equal(result.status, 'executing');
  });

  it('awaiting_approval -> escalated', async () => {
    mockGetReturning(createMockIncident({ status: 'awaiting_approval' }));
    const result = await transitionIncident('INC-TEST-001', 'escalated');
    assert.equal(result.status, 'escalated');
  });

  it('executing -> verifying', async () => {
    mockGetReturning(createMockIncident({ status: 'executing' }));
    const result = await transitionIncident('INC-TEST-001', 'verifying');
    assert.equal(result.status, 'verifying');
  });

  it('verifying -> resolved', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying' }));
    const result = await transitionIncident('INC-TEST-001', 'resolved');
    assert.equal(result.status, 'resolved');
  });

  it('verifying -> reflecting when count < 3', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying', reflection_count: 1 }));
    const result = await transitionIncident('INC-TEST-001', 'reflecting');
    assert.equal(result.status, 'reflecting');
  });

  it('reflecting -> investigating', async () => {
    mockGetReturning(createMockIncident({ status: 'reflecting' }));
    const result = await transitionIncident('INC-TEST-001', 'investigating');
    assert.equal(result.status, 'investigating');
  });

  it('escalated -> investigating', async () => {
    mockGetReturning(createMockIncident({ status: 'escalated' }));
    const result = await transitionIncident('INC-TEST-001', 'investigating');
    assert.equal(result.status, 'investigating');
  });
});

// ─── transitionIncident — invalid transitions ───────────────

describe('transitionIncident — invalid transitions', () => {
  it('detected -> investigating throws InvalidTransitionError', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'investigating'),
      (err) => {
        assert.equal(err.name, 'InvalidTransitionError');
        assert.equal(err.currentStatus, 'detected');
        assert.equal(err.newStatus, 'investigating');
        return true;
      }
    );
  });

  it('detected -> resolved throws InvalidTransitionError', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'resolved'),
      (err) => {
        assert.equal(err.name, 'InvalidTransitionError');
        assert.equal(err.currentStatus, 'detected');
        assert.equal(err.newStatus, 'resolved');
        return true;
      }
    );
  });

  it('resolved -> investigating throws InvalidTransitionError', async () => {
    mockGetReturning(createMockIncident({ status: 'resolved' }));
    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'investigating'),
      (err) => {
        assert.equal(err.name, 'InvalidTransitionError');
        assert.equal(err.currentStatus, 'resolved');
        return true;
      }
    );
  });

  it('suppressed -> investigating throws InvalidTransitionError', async () => {
    mockGetReturning(createMockIncident({ status: 'suppressed' }));
    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'investigating'),
      (err) => {
        assert.equal(err.name, 'InvalidTransitionError');
        assert.equal(err.currentStatus, 'suppressed');
        return true;
      }
    );
  });

  it('verifying -> executing throws InvalidTransitionError', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying' }));
    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'executing'),
      (err) => {
        assert.equal(err.name, 'InvalidTransitionError');
        assert.equal(err.currentStatus, 'verifying');
        assert.equal(err.newStatus, 'executing');
        return true;
      }
    );
  });

  it('planning -> verifying throws InvalidTransitionError', async () => {
    mockGetReturning(createMockIncident({ status: 'planning' }));
    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'verifying'),
      (err) => {
        assert.equal(err.name, 'InvalidTransitionError');
        assert.equal(err.currentStatus, 'planning');
        assert.equal(err.newStatus, 'verifying');
        return true;
      }
    );
  });
});

// ─── Reflection limit guard ─────────────────────────────────

describe('reflection limit guard', () => {
  it('auto-escalates when count === MAX', async () => {
    // First getIncident: doc in verifying state triggers reflection limit guard
    // Second getIncident (recursive call): doc in reflecting state so escalated is valid
    let callCount = 0;
    mockClientGet.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          _source: createMockIncident({ status: 'verifying', reflection_count: 3 }),
          _seq_no: 1, _primary_term: 1
        };
      }
      return {
        _source: createMockIncident({ status: 'reflecting', reflection_count: 3 }),
        _seq_no: 2, _primary_term: 1
      };
    });
    const result = await transitionIncident('INC-TEST-001', 'reflecting');
    assert.equal(result.status, 'escalated');
    // client.get is called twice: once for reflecting attempt, once for the recursive escalated call
    assert.equal(mockClientGet.mock.callCount(), 2);
  });

  it('allows reflecting when count < limit', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying', reflection_count: 2 }));
    const result = await transitionIncident('INC-TEST-001', 'reflecting');
    assert.equal(result.status, 'reflecting');
  });

  it('increments reflection_count by 1 on reflecting entry', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying', reflection_count: 1 }));
    const result = await transitionIncident('INC-TEST-001', 'reflecting');
    assert.equal(result.reflection_count, 2);
  });

  it('sets resolution_type to escalated on auto-escalation', async () => {
    let callCount = 0;
    mockClientGet.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          _source: createMockIncident({ status: 'verifying', reflection_count: 3 }),
          _seq_no: 1, _primary_term: 1
        };
      }
      return {
        _source: createMockIncident({ status: 'reflecting', reflection_count: 3 }),
        _seq_no: 2, _primary_term: 1
      };
    });
    const result = await transitionIncident('INC-TEST-001', 'reflecting');
    assert.equal(result.resolution_type, 'escalated');
  });
});

// ─── Terminal state handling ────────────────────────────────

describe('terminal state handling', () => {
  it('resolved sets resolved_at and resolution_type auto_resolved', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying' }));
    const result = await transitionIncident('INC-TEST-001', 'resolved');
    assert.ok(result.resolved_at);
    assert.equal(result.resolution_type, 'auto_resolved');
  });

  it('suppressed sets resolved_at and resolution_type suppressed', async () => {
    mockGetReturning(createMockIncident({ status: 'triaged' }));
    const result = await transitionIncident('INC-TEST-001', 'suppressed');
    assert.ok(result.resolved_at);
    assert.equal(result.resolution_type, 'suppressed');
  });

  it('escalated sets resolution_type escalated', async () => {
    mockGetReturning(createMockIncident({ status: 'awaiting_approval' }));
    const result = await transitionIncident('INC-TEST-001', 'escalated');
    assert.equal(result.resolution_type, 'escalated');
  });

  it('resolved computes total_duration_seconds', async () => {
    mockGetReturning(createMockIncident({ status: 'verifying' }));
    const result = await transitionIncident('INC-TEST-001', 'resolved');
    assert.equal(typeof result.total_duration_seconds, 'number');
    assert.ok(result.total_duration_seconds >= 0);
  });
});

// ─── Optimistic concurrency ─────────────────────────────────

describe('optimistic concurrency', () => {
  it('throws ConcurrencyError when ES returns 409', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    const conflictErr = new Error('version conflict');
    conflictErr.meta = { statusCode: 409 };
    mockClientUpdate.mock.mockImplementation(async () => { throw conflictErr; });

    await assert.rejects(
      () => transitionIncident('INC-TEST-001', 'triaged'),
      (err) => {
        assert.equal(err.name, 'ConcurrencyError');
        assert.equal(err.incidentId, 'INC-TEST-001');
        return true;
      }
    );
  });
});

// ─── Audit trail ────────────────────────────────────────────

describe('audit trail', () => {
  it('indexes state_transition record to vigil-actions', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    await transitionIncident('INC-TEST-001', 'triaged');

    assert.equal(mockClientIndex.mock.callCount(), 1);
    const indexCall = mockClientIndex.mock.calls[0].arguments[0];
    assert.equal(indexCall.index, 'vigil-actions');
    assert.equal(indexCall.document.incident_id, 'INC-TEST-001');
    assert.equal(indexCall.document.action_type, 'state_transition');
    assert.equal(indexCall.document.previous_status, 'detected');
    assert.equal(indexCall.document.new_status, 'triaged');
  });

  it('logs error but does not throw when audit write fails', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    mockClientIndex.mock.mockImplementation(async () => {
      throw new Error('ES cluster unavailable');
    });

    // Should not reject despite audit failure
    const result = await transitionIncident('INC-TEST-001', 'triaged');
    assert.equal(result.status, 'triaged');
  });
});

// ─── _state_timestamps ──────────────────────────────────────

describe('_state_timestamps', () => {
  it('records entry timestamp for each new state', async () => {
    mockGetReturning(createMockIncident({ status: 'detected' }));
    const result = await transitionIncident('INC-TEST-001', 'triaged');
    assert.ok(result._state_timestamps.triaged);
  });

  it('preserves timestamps from previous states', async () => {
    const doc = createMockIncident({
      status: 'detected',
      _state_timestamps: { detected: '2026-02-17T10:30:00.000Z' }
    });
    mockGetReturning(doc);
    const result = await transitionIncident('INC-TEST-001', 'triaged');
    assert.equal(result._state_timestamps.detected, '2026-02-17T10:30:00.000Z');
    assert.ok(result._state_timestamps.triaged);
  });
});
