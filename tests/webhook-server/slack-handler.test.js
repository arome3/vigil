// Unit tests for the Slack interaction handler.
//
// Tests the pure-function API:
//   verifySlackSignature(signingSecret, timestamp, body, signature) → boolean
//   handleApprovalCallback(payload) → { incidentId, action, updatedBy, indexed }

import { jest } from '@jest/globals';
import crypto from 'crypto';

const mockSearch = jest.fn();
const mockIndex = jest.fn();

jest.unstable_mockModule('../../src/utils/elastic-client.js', () => ({
  default: { search: mockSearch, index: mockIndex }
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const TEST_SIGNING_SECRET = 'test-signing-secret-for-hmac';

const { verifySlackSignature, handleApprovalCallback } = await import(
  '../../src/webhook-server/slack-handler.js'
);

// --- Helpers ---

function signRequest(body, secret = TEST_SIGNING_SECRET, timestamp = null) {
  const ts = timestamp || Math.floor(Date.now() / 1000).toString();
  const sigBasestring = `v0:${ts}:${body}`;
  const sig = 'v0=' + crypto
    .createHmac('sha256', secret)
    .update(sigBasestring, 'utf8')
    .digest('hex');
  return { timestamp: ts, signature: sig };
}

function buildPayload(actionId, actionValue, userName = 'sre-oncall') {
  return {
    actions: [{
      action_id: actionId,
      value: actionValue
    }],
    user: { name: userName, username: userName }
  };
}

// --- Tests ---

describe('slack-handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIndex.mockResolvedValue({ result: 'created' });
  });

  // ── Signature verification ────────────────────────────

  describe('verifySlackSignature', () => {
    test('returns true for valid signature', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signRequest(body);

      expect(verifySlackSignature(TEST_SIGNING_SECRET, timestamp, body, signature)).toBe(true);
    });

    test('returns false for tampered body', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signRequest(body);

      expect(verifySlackSignature(TEST_SIGNING_SECRET, timestamp, 'payload=tampered', signature)).toBe(false);
    });

    test('returns false for wrong secret', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signRequest(body, 'wrong-secret');

      expect(verifySlackSignature(TEST_SIGNING_SECRET, timestamp, body, signature)).toBe(false);
    });

    test('returns false for timestamp older than 5 minutes', () => {
      const body = 'payload=test';
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
      const { signature } = signRequest(body, TEST_SIGNING_SECRET, oldTimestamp);

      expect(verifySlackSignature(TEST_SIGNING_SECRET, oldTimestamp, body, signature)).toBe(false);
    });

    test('returns false when parameters are missing', () => {
      expect(verifySlackSignature(null, '12345', 'test', 'v0=abc')).toBe(false);
      expect(verifySlackSignature(TEST_SIGNING_SECRET, null, 'test', 'v0=abc')).toBe(false);
      expect(verifySlackSignature(TEST_SIGNING_SECRET, '12345', null, 'v0=abc')).toBe(false);
      expect(verifySlackSignature(TEST_SIGNING_SECRET, '12345', 'test', null)).toBe(false);
    });
  });

  // ── Approval callback: approve/reject ─────────────────

  describe('handleApprovalCallback - approve/reject', () => {
    test('indexes normalized "approve" for "approved" button value', async () => {
      const payload = buildPayload('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');

      const result = await handleApprovalCallback(payload);

      expect(mockIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'vigil-approval-responses',
          document: expect.objectContaining({
            incident_id: 'INC-2026-001',
            action_id: 'ACT-2026-AAAAA',
            value: 'approve',
            user: 'sre-oncall'
          })
        })
      );
      expect(result).toEqual(expect.objectContaining({
        incidentId: 'INC-2026-001',
        action: 'approve',
        updatedBy: 'sre-oncall',
        indexed: true
      }));
    });

    test('indexes normalized "reject" for "rejected" button value', async () => {
      const payload = buildPayload('vigil_reject_INC-2026-001', 'rejected|ACT-2026-BBBBB', 'ciso');

      const result = await handleApprovalCallback(payload);

      expect(mockIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'vigil-approval-responses',
          document: expect.objectContaining({
            incident_id: 'INC-2026-001',
            action_id: 'ACT-2026-BBBBB',
            value: 'reject',
            user: 'ciso',
            reason: 'Rejected by ciso'
          })
        })
      );
      expect(result).toEqual(expect.objectContaining({
        action: 'reject',
        updatedBy: 'ciso',
        indexed: true
      }));
    });

    test('sets reason to null for approve', async () => {
      const payload = buildPayload('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');

      await handleApprovalCallback(payload);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.reason).toBeNull();
    });

    test('extracts action_id from pipe-delimited value', async () => {
      const payload = buildPayload('vigil_approve_INC-2026-001', 'approved|ACT-2026-CCCCC');

      await handleApprovalCallback(payload);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.action_id).toBe('ACT-2026-CCCCC');
    });

    test('handles missing action_id gracefully', async () => {
      const payload = buildPayload('vigil_approve_INC-2026-001', 'approved');

      await handleApprovalCallback(payload);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.action_id).toBeNull();
    });
  });

  // ── Approval callback: info button ────────────────────

  describe('handleApprovalCallback - info button', () => {
    test('returns info result without indexing', async () => {
      const payload = buildPayload('vigil_info_INC-2026-001', 'info|ACT-2026-AAAAA');

      const result = await handleApprovalCallback(payload);

      // Info actions are handled at the webhook-server layer, not in approval-handler
      expect(mockIndex).not.toHaveBeenCalled();
      expect(result).toEqual({
        incidentId: 'INC-2026-001',
        action: 'info',
        updatedBy: 'sre-oncall',
        indexed: false
      });
    });
  });

  // ── Error handling ────────────────────────────────────

  describe('error handling', () => {
    test('returns indexed:false when ES index fails', async () => {
      mockIndex.mockRejectedValue(new Error('ES cluster down'));

      const payload = buildPayload('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');

      const result = await handleApprovalCallback(payload);

      expect(result.indexed).toBe(false);
      expect(result.incidentId).toBe('INC-2026-001');
      expect(result.action).toBe('approve');
    });

    test('returns null fields when no action in payload', async () => {
      const result = await handleApprovalCallback({ actions: [] });

      expect(result).toEqual({
        incidentId: null,
        action: null,
        updatedBy: null,
        indexed: false
      });
    });

    test('returns null fields when payload has no actions property', async () => {
      const result = await handleApprovalCallback({});

      expect(result).toEqual({
        incidentId: null,
        action: null,
        updatedBy: null,
        indexed: false
      });
    });
  });

  // ── Incident ID extraction ────────────────────────────

  describe('incident ID extraction', () => {
    test('strips vigil_approve_ prefix', async () => {
      const payload = buildPayload('vigil_approve_INC-2026-00142', 'approved|ACT-2026-AAAAA');

      await handleApprovalCallback(payload);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.incident_id).toBe('INC-2026-00142');
    });

    test('strips vigil_reject_ prefix', async () => {
      const payload = buildPayload('vigil_reject_INC-2026-00142', 'rejected|ACT-2026-BBBBB');

      await handleApprovalCallback(payload);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.incident_id).toBe('INC-2026-00142');
    });

    test('uses full action_id when prefix does not match', async () => {
      const payload = buildPayload('unknown_prefix_INC-2026-001', 'approved|ACT-2026-AAAAA');

      await handleApprovalCallback(payload);

      const doc = mockIndex.mock.calls[0][0].document;
      // No prefix stripped — the full action_id becomes the incident_id
      expect(doc.incident_id).toBe('unknown_prefix_INC-2026-001');
    });
  });
});
