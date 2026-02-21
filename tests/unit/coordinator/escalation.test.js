import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock functions ─────────────────────────────────────────

const mockSendA2AMessage = mock.fn();
const mockCreateEnvelope = mock.fn((_from, _to, _corr, payload) => ({
  message_id: 'msg-test',
  from_agent: _from,
  to_agent: _to,
  timestamp: '2026-02-20T10:00:00.000Z',
  correlation_id: _corr,
  payload
}));
const mockGetIncident = mock.fn();
const mockClientUpdate = mock.fn();

// ─── Register mocks before import ───────────────────────────

mock.module(import.meta.resolve('../../../src/a2a/router.js'), {
  namedExports: { sendA2AMessage: mockSendA2AMessage }
});

mock.module(import.meta.resolve('../../../src/a2a/message-envelope.js'), {
  namedExports: { createEnvelope: mockCreateEnvelope }
});

mock.module(import.meta.resolve('../../../src/state-machine/transitions.js'), {
  namedExports: { getIncident: mockGetIncident }
});

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: { update: mockClientUpdate }
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

// ─── Import module under test ───────────────────────────────

const { escalateIncident, checkConflictingAssessments, checkApprovalTimeout } =
  await import('../../../src/agents/coordinator/escalation.js');

// ─── Helpers ────────────────────────────────────────────────

function makeIncidentDoc(overrides = {}) {
  return {
    incident_id: 'INC-2026-TEST1',
    status: 'escalated',
    incident_type: 'security',
    severity: 'high',
    investigation_summary: 'Credential theft via phishing',
    affected_services: ['api-gateway'],
    escalation_triggered: false,
    reflection_count: 0,
    ...overrides
  };
}

// ─── Tests: escalateIncident ────────────────────────────────

describe('escalateIncident', () => {
  beforeEach(() => {
    mockSendA2AMessage.mock.resetCalls();
    mockCreateEnvelope.mock.resetCalls();
    mockGetIncident.mock.resetCalls();
    mockClientUpdate.mock.resetCalls();
  });

  it('sets escalation_triggered flag with optimistic concurrency', async () => {
    const doc = makeIncidentDoc();
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: { ...doc, escalation_triggered: false },
      _seq_no: 5,
      _primary_term: 1
    }));
    mockClientUpdate.mock.mockImplementation(async () => ({ result: 'updated' }));
    mockSendA2AMessage.mock.mockImplementation(async () => ({ status: 'sent' }));

    const result = await escalateIncident(doc, 'test reason');

    assert.equal(result.skipped, false);
    assert.equal(result.reason, 'test reason');

    const updateCall = mockClientUpdate.mock.calls[0];
    assert.equal(updateCall.arguments[0].if_seq_no, 5);
    assert.equal(updateCall.arguments[0].if_primary_term, 1);
    assert.equal(updateCall.arguments[0].doc.escalation_triggered, true);
    assert.equal(updateCall.arguments[0].doc.escalation_reason, 'test reason');
  });

  it('skips duplicate escalation when already triggered', async () => {
    const doc = makeIncidentDoc({ escalation_triggered: true });
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: { ...doc, escalation_triggered: true },
      _seq_no: 5,
      _primary_term: 1
    }));

    const result = await escalateIncident(doc, 'test reason');

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already_escalated');
    assert.equal(mockClientUpdate.mock.callCount(), 0);
  });

  it('handles concurrency conflict gracefully', async () => {
    const doc = makeIncidentDoc();
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: { ...doc, escalation_triggered: false },
      _seq_no: 5,
      _primary_term: 1
    }));
    mockClientUpdate.mock.mockImplementation(async () => {
      const err = new Error('version_conflict_engine_exception');
      err.meta = { statusCode: 409 };
      throw err;
    });

    const result = await escalateIncident(doc, 'test reason');

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'concurrency_conflict');
  });

  it('sends notification via vigil-wf-notify', async () => {
    const doc = makeIncidentDoc();
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: { ...doc, escalation_triggered: false },
      _seq_no: 5,
      _primary_term: 1
    }));
    mockClientUpdate.mock.mockImplementation(async () => ({ result: 'updated' }));
    mockSendA2AMessage.mock.mockImplementation(async () => ({ status: 'sent' }));

    await escalateIncident(doc, 'test reason');

    assert.equal(mockSendA2AMessage.mock.callCount(), 1);
    const [agentId] = mockSendA2AMessage.mock.calls[0].arguments;
    assert.equal(agentId, 'vigil-wf-notify');
  });

  it('logs error but does not throw when notification fails', async () => {
    const doc = makeIncidentDoc();
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: { ...doc, escalation_triggered: false },
      _seq_no: 5,
      _primary_term: 1
    }));
    mockClientUpdate.mock.mockImplementation(async () => ({ result: 'updated' }));
    mockSendA2AMessage.mock.mockImplementation(async () => {
      throw new Error('notification service unavailable');
    });

    const result = await escalateIncident(doc, 'test reason');

    assert.equal(result.skipped, false);
    assert.equal(result.reason, 'test reason');
  });
});

// ─── Tests: checkConflictingAssessments ─────────────────────

describe('checkConflictingAssessments', () => {
  it('returns conflicting false when no threat hunter response', () => {
    const investigatorResp = {
      blast_radius: [{ asset_id: 'web-1', confidence: 0.9 }]
    };
    const result = checkConflictingAssessments(investigatorResp, null);
    assert.equal(result.conflicting, false);
  });

  it('returns conflicting false when scopes align', () => {
    const investigatorResp = {
      blast_radius: [
        { asset_id: 'web-1', confidence: 0.9 },
        { asset_id: 'db-1', confidence: 0.8 }
      ]
    };
    const threatHunterResp = {
      confirmed_compromised: [
        { asset_id: 'web-1' }
      ],
      suspected_compromised: []
    };
    const result = checkConflictingAssessments(investigatorResp, threatHunterResp);
    assert.equal(result.conflicting, false);
  });

  it('returns conflicting true when hunter finds assets not identified by investigator', () => {
    const investigatorResp = {
      blast_radius: [
        { asset_id: 'web-1', confidence: 0.9 }
      ]
    };
    const threatHunterResp = {
      confirmed_compromised: [
        { asset_id: 'web-1' },
        { asset_id: 'db-1' }
      ],
      suspected_compromised: []
    };
    const result = checkConflictingAssessments(investigatorResp, threatHunterResp);
    assert.equal(result.conflicting, true);
    assert.ok(result.reason.includes('db-1'));
    assert.ok(Array.isArray(result.investigator_scope));
    assert.ok(Array.isArray(result.hunter_scope));
  });
});

// ─── Tests: checkApprovalTimeout ────────────────────────────

describe('checkApprovalTimeout', () => {
  it('returns true when elapsed time exceeds timeout', () => {
    const doc = makeIncidentDoc();
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    assert.equal(checkApprovalTimeout(doc, twentyMinutesAgo), true);
  });

  it('returns false when within timeout window', () => {
    const doc = makeIncidentDoc();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(checkApprovalTimeout(doc, fiveMinutesAgo), false);
  });

  it('returns false when approvalStartTime is null', () => {
    const doc = makeIncidentDoc();
    assert.equal(checkApprovalTimeout(doc, null), false);
  });
});
