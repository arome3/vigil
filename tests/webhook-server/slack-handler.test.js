// Unit tests for the Slack interaction handler.

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

// Set the signing secret before importing the handler
const TEST_SIGNING_SECRET = 'test-signing-secret-for-hmac';
process.env.SLACK_SIGNING_SECRET = TEST_SIGNING_SECRET;

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

function buildReq(actionId, actionValue, userName = 'sre-oncall') {
  const payload = {
    actions: [{
      action_id: actionId,
      value: actionValue
    }],
    user: { name: userName, username: userName },
    channel: { id: 'C123' },
    message: { ts: '1234567890.123456' }
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  return {
    rawBody: body,
    body: { payload: JSON.stringify(payload) },
    headers: {}
  };
}

function buildRes() {
  const res = {
    statusCode: null,
    responseBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.responseBody = body; return this; }
  };
  return res;
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

      const req = {
        rawBody: body,
        headers: {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature
        }
      };

      expect(verifySlackSignature(req)).toBe(true);
    });

    test('returns false for tampered body', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signRequest(body);

      const req = {
        rawBody: 'payload=tampered',
        headers: {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature
        }
      };

      expect(verifySlackSignature(req)).toBe(false);
    });

    test('returns false for wrong secret', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signRequest(body, 'wrong-secret');

      const req = {
        rawBody: body,
        headers: {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature
        }
      };

      expect(verifySlackSignature(req)).toBe(false);
    });

    test('returns false for timestamp older than 5 minutes', () => {
      const body = 'payload=test';
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
      const { signature } = signRequest(body, TEST_SIGNING_SECRET, oldTimestamp);

      const req = {
        rawBody: body,
        headers: {
          'x-slack-request-timestamp': oldTimestamp,
          'x-slack-signature': signature
        }
      };

      expect(verifySlackSignature(req)).toBe(false);
    });

    test('returns false when headers are missing', () => {
      expect(verifySlackSignature({ rawBody: 'test', headers: {} })).toBe(false);
    });
  });

  // ── Approval callback: approve/reject ─────────────────

  describe('handleApprovalCallback - approve/reject', () => {
    test('indexes normalized "approve" for "approved" button value', async () => {
      const req = buildReq('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

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
      expect(res.statusCode).toBe(200);
      expect(res.responseBody).toEqual({ ok: true });
    });

    test('indexes normalized "reject" for "rejected" button value', async () => {
      const req = buildReq('vigil_reject_INC-2026-001', 'rejected|ACT-2026-BBBBB', 'ciso');
      const res = buildRes();

      await handleApprovalCallback(req, res);

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
    });

    test('sets reason to null for approve', async () => {
      const req = buildReq('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.reason).toBeNull();
    });

    test('extracts action_id from pipe-delimited value', async () => {
      const req = buildReq('vigil_approve_INC-2026-001', 'approved|ACT-2026-CCCCC');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.action_id).toBe('ACT-2026-CCCCC');
    });

    test('handles missing action_id gracefully', async () => {
      const req = buildReq('vigil_approve_INC-2026-001', 'approved');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.action_id).toBeNull();
    });
  });

  // ── Approval callback: info button ────────────────────

  describe('handleApprovalCallback - info button', () => {
    test('fetches incident and returns ephemeral message', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              incident_id: 'INC-2026-001',
              investigation_summary: 'Brute force attack detected',
              affected_assets: [{ name: 'api-gateway' }, { name: 'auth-service' }],
              severity: 'critical',
              status: 'investigating'
            }
          }]
        }
      });

      const req = buildReq('vigil_info_INC-2026-001', 'info|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      // Should NOT index to approval-responses
      expect(mockIndex).not.toHaveBeenCalled();

      expect(res.statusCode).toBe(200);
      expect(res.responseBody.response_type).toBe('ephemeral');
      expect(res.responseBody.text).toContain('Brute force attack detected');
      expect(res.responseBody.text).toContain('api-gateway');
    });

    test('responds with "not found" when incident missing', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [] } });

      const req = buildReq('vigil_info_INC-2026-999', 'info|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.responseBody.text).toContain('No incident found');
    });
  });

  // ── Error handling ────────────────────────────────────

  describe('error handling', () => {
    test('responds 200 even when ES index fails (prevents Slack retry)', async () => {
      mockIndex.mockRejectedValue(new Error('ES cluster down'));

      const req = buildReq('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.responseBody).toEqual({ ok: true });
    });

    test('responds 200 with error for invalid payload', async () => {
      const req = {
        body: { payload: 'not json' },
        headers: {}
      };
      const res = buildRes();

      await handleApprovalCallback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.responseBody.ok).toBe(false);
    });

    test('responds 200 when no action in payload', async () => {
      const req = {
        body: { payload: JSON.stringify({ actions: [] }) },
        headers: {}
      };
      const res = buildRes();

      await handleApprovalCallback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.responseBody.ok).toBe(false);
    });
  });

  // ── Slack message update ─────────────────────────────

  describe('Slack message update', () => {
    const mockChatUpdate = jest.fn();

    beforeEach(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockChatUpdate.mockResolvedValue({ ok: true });
    });

    afterEach(() => {
      delete process.env.SLACK_BOT_TOKEN;
    });

    test('calls chat.update when SLACK_BOT_TOKEN is set', async () => {
      // Dynamic import of @slack/web-api is inside the handler, so we mock it
      // at the module level. The handler does `await import('@slack/web-api')`
      // which returns the mocked module.
      jest.unstable_mockModule('@slack/web-api', () => ({
        WebClient: class {
          constructor() {
            this.chat = { update: mockChatUpdate };
          }
        }
      }));

      const req = buildReq('vigil_approve_INC-2026-001', 'approved|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: '1234567890.123456',
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'section'
            })
          ])
        })
      );
      expect(res.statusCode).toBe(200);
    });

    test('responds 200 when chat.update fails', async () => {
      mockChatUpdate.mockRejectedValue(new Error('Slack API error'));

      jest.unstable_mockModule('@slack/web-api', () => ({
        WebClient: class {
          constructor() {
            this.chat = { update: mockChatUpdate };
          }
        }
      }));

      const req = buildReq('vigil_reject_INC-2026-001', 'rejected|ACT-2026-BBBBB');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      // Should still respond 200 — chat.update failure is non-fatal
      expect(res.statusCode).toBe(200);
      expect(res.responseBody).toEqual({ ok: true });
    });
  });

  // ── Incident ID extraction ────────────────────────────

  describe('incident ID extraction', () => {
    test('strips vigil_approve_ prefix', async () => {
      const req = buildReq('vigil_approve_INC-2026-00142', 'approved|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.incident_id).toBe('INC-2026-00142');
    });

    test('strips vigil_reject_ prefix', async () => {
      const req = buildReq('vigil_reject_INC-2026-00142', 'rejected|ACT-2026-BBBBB');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      const doc = mockIndex.mock.calls[0][0].document;
      expect(doc.incident_id).toBe('INC-2026-00142');
    });

    test('uses full action_id when prefix does not match', async () => {
      const req = buildReq('unknown_prefix_INC-2026-001', 'approved|ACT-2026-AAAAA');
      const res = buildRes();

      await handleApprovalCallback(req, res);

      const doc = mockIndex.mock.calls[0][0].document;
      // No prefix stripped — the full action_id becomes the incident_id
      expect(doc.incident_id).toBe('unknown_prefix_INC-2026-001');
    });
  });
});
