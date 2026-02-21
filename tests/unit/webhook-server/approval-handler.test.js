import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock setup ─────────────────────────────────────────────

const mockClientIndex = mock.fn();

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

// ─── Import module under test ───────────────────────────────

const { handleApprovalCallback } =
  await import('../../../src/webhook-server/approval-handler.js');

// ─── Helpers ────────────────────────────────────────────────

function makePayload({ actionId, value, userName } = {}) {
  return {
    actions: [
      {
        action_id: actionId || 'vigil_approve_INC-2026-001',
        value: value || 'approved|ACT-001'
      }
    ],
    user: { name: userName || 'test-user' }
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('webhook-server/approval-handler', () => {
  beforeEach(() => {
    mockClientIndex.mock.resetCalls();
    mockClientIndex.mock.mockImplementation(async () => ({ result: 'created' }));
  });

  // ── Approve flow ────────────────────────────────────────

  describe('approve action', () => {
    it('normalizes "approved" to "approve" and indexes', async () => {
      const result = await handleApprovalCallback(makePayload());

      assert.equal(result.incidentId, 'INC-2026-001');
      assert.equal(result.action, 'approve');
      assert.equal(result.updatedBy, 'test-user');
      assert.equal(result.indexed, true);

      assert.equal(mockClientIndex.mock.callCount(), 1);
      const indexCall = mockClientIndex.mock.calls[0].arguments[0];
      assert.equal(indexCall.index, 'vigil-approval-responses');
      assert.equal(indexCall.document.value, 'approve');
      assert.equal(indexCall.document.incident_id, 'INC-2026-001');
      assert.equal(indexCall.document.action_id, 'ACT-001');
      assert.equal(indexCall.document.reason, null);
    });
  });

  // ── Reject flow ─────────────────────────────────────────

  describe('reject action', () => {
    it('normalizes "rejected" to "reject" and includes reason', async () => {
      const payload = makePayload({
        actionId: 'vigil_reject_INC-2026-002',
        value: 'rejected|ACT-002'
      });

      const result = await handleApprovalCallback(payload);

      assert.equal(result.incidentId, 'INC-2026-002');
      assert.equal(result.action, 'reject');
      assert.equal(result.indexed, true);

      const doc = mockClientIndex.mock.calls[0].arguments[0].document;
      assert.ok(doc.reason.includes('Rejected by'));
    });
  });

  // ── Info flow ───────────────────────────────────────────

  describe('info action', () => {
    it('returns action: "info" and does NOT index', async () => {
      const payload = makePayload({
        actionId: 'vigil_info_INC-2026-003',
        value: 'info|INC-2026-003'
      });

      const result = await handleApprovalCallback(payload);

      assert.equal(result.incidentId, 'INC-2026-003');
      assert.equal(result.action, 'info');
      assert.equal(result.indexed, false);
      assert.equal(mockClientIndex.mock.callCount(), 0);
    });
  });

  // ── No action ───────────────────────────────────────────

  describe('no action in payload', () => {
    it('returns nulls with indexed: false', async () => {
      const result = await handleApprovalCallback({ actions: [] });

      assert.equal(result.incidentId, null);
      assert.equal(result.action, null);
      assert.equal(result.updatedBy, null);
      assert.equal(result.indexed, false);
      assert.equal(mockClientIndex.mock.callCount(), 0);
    });
  });

  // ── ES failure ──────────────────────────────────────────

  describe('Elasticsearch failure', () => {
    it('logs error and returns indexed: false (does not throw)', async () => {
      mockClientIndex.mock.mockImplementation(async () => {
        throw new Error('ES connection refused');
      });

      const result = await handleApprovalCallback(makePayload());

      assert.equal(result.incidentId, 'INC-2026-001');
      assert.equal(result.action, 'approve');
      assert.equal(result.indexed, false);
    });
  });

  // ── Incident ID extraction ─────────────────────────────

  describe('incident ID extraction', () => {
    it('strips vigil_approve_ prefix', async () => {
      const payload = makePayload({ actionId: 'vigil_approve_INC-2026-100' });
      const result = await handleApprovalCallback(payload);
      assert.equal(result.incidentId, 'INC-2026-100');
    });

    it('strips vigil_reject_ prefix', async () => {
      const payload = makePayload({
        actionId: 'vigil_reject_INC-2026-200',
        value: 'rejected|ACT-X'
      });
      const result = await handleApprovalCallback(payload);
      assert.equal(result.incidentId, 'INC-2026-200');
    });

    it('strips vigil_info_ prefix', async () => {
      const payload = makePayload({
        actionId: 'vigil_info_INC-2026-300',
        value: 'info|INC-2026-300'
      });
      const result = await handleApprovalCallback(payload);
      assert.equal(result.incidentId, 'INC-2026-300');
    });

    it('returns nulls for invalid incidentId (empty after prefix strip)', async () => {
      const payload = makePayload({
        actionId: 'vigil_approve_',
        value: 'approved|ACT-001'
      });
      const result = await handleApprovalCallback(payload);

      assert.equal(result.incidentId, null);
      assert.equal(result.action, null);
      assert.equal(result.updatedBy, null);
      assert.equal(result.indexed, false);
      assert.equal(mockClientIndex.mock.callCount(), 0);
    });

    it('returns nulls for incidentId with invalid characters', async () => {
      const payload = makePayload({
        actionId: 'vigil_approve_INC/../etc/passwd',
        value: 'approved|ACT-001'
      });
      const result = await handleApprovalCallback(payload);

      assert.equal(result.incidentId, null);
      assert.equal(result.indexed, false);
    });
  });
});
