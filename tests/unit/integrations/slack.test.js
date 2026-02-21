import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// ─── Environment variables (must be set before import) ──────
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.SLACK_INCIDENT_CHANNEL = '#test-incidents';
process.env.SLACK_APPROVAL_CHANNEL = '#test-approvals';

// ─── Mock setup ─────────────────────────────────────────────

const mockAxios = mock.fn();

mock.module('axios', {
  defaultExport: mockAxios
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

mock.module(import.meta.resolve('../../../src/integrations/circuit-breaker.js'), {
  namedExports: {
    execBreaker: async (_name, fn) => fn(),
    getBreaker: () => null,
    resetBreaker: () => {}
  }
});

// ─── Import module under test ───────────────────────────────

const {
  postIncidentNotification,
  postApprovalRequest,
  postResolutionSummary,
  postEscalationAlert,
  verifySlackSignature
} = await import('../../../src/integrations/slack.js');

// ─── Helpers ────────────────────────────────────────────────

function mockSlackSuccess() {
  mockAxios.mock.resetCalls();
  mockAxios.mock.mockImplementation(async () => ({
    status: 200,
    data: { ok: true, ts: '1234567890.123', channel: '#test-incidents' },
    headers: {}
  }));
}

function makeIncident(overrides = {}) {
  return {
    incident_id: 'INC-2026-001',
    severity: 'critical',
    type: 'brute-force',
    service: 'auth-service',
    status: 'investigating',
    investigation_summary: 'Multiple failed logins detected',
    ...overrides
  };
}

function signBody(body, secret = 'test-signing-secret', timestamp = null) {
  const ts = timestamp || Math.floor(Date.now() / 1000).toString();
  const sigBasestring = `v0:${ts}:${body}`;
  const sig = 'v0=' + crypto
    .createHmac('sha256', secret)
    .update(sigBasestring, 'utf8')
    .digest('hex');
  return { timestamp: ts, signature: sig };
}

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/slack', () => {
  beforeEach(() => {
    mockSlackSuccess();
  });

  // ── postIncidentNotification ────────────────────────────

  describe('postIncidentNotification', () => {
    it('sends Block Kit message with severity, type, and service', async () => {
      const incident = makeIncident();
      const result = await postIncidentNotification(incident);

      assert.equal(result.ok, true);
      assert.equal(result.ts, '1234567890.123');

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.method, 'POST');
      assert.ok(callArgs.url.includes('chat.postMessage'));
      assert.ok(callArgs.headers.Authorization.startsWith('Bearer '));

      const blocks = callArgs.data.blocks;
      assert.ok(blocks.length >= 2, 'Should have at least header + section blocks');

      // Verify fields contain severity/type/service
      const fieldsBlock = blocks.find((b) => b.fields);
      const fieldTexts = fieldsBlock.fields.map((f) => f.text).join(' ');
      assert.ok(fieldTexts.includes('critical'));
      assert.ok(fieldTexts.includes('brute-force'));
      assert.ok(fieldTexts.includes('auth-service'));
    });

    it('retries on 429 response', async () => {
      let callCount = 0;
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('rate limited');
          err.response = { status: 429, headers: { 'retry-after': '0' } };
          throw err;
        }
        return {
          status: 200,
          data: { ok: true, ts: '111', channel: '#test' },
          headers: {}
        };
      });

      const result = await postIncidentNotification(makeIncident());
      assert.equal(result.ok, true);
      assert.equal(callCount, 2, 'Should have retried once');
    });

    it('throws on 401 without retry', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => {
        const err = new Error('unauthorized');
        err.response = { status: 401, headers: {} };
        throw err;
      });

      await assert.rejects(
        () => postIncidentNotification(makeIncident()),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.equal(err.retryable, false);
          return true;
        }
      );

      assert.equal(mockAxios.mock.callCount(), 1, 'Should not retry 401');
    });
  });

  // ── postApprovalRequest ────────────────────────────────

  describe('postApprovalRequest', () => {
    it('sends to approval channel with action buttons containing incident_id', async () => {
      const incident = makeIncident();
      const actions = [{ action_id: 'ACT-001', label: 'Restart pod' }];
      const result = await postApprovalRequest(incident, actions);

      assert.equal(result.ok, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.data.channel, '#test-approvals');

      const actionsBlock = callArgs.data.blocks.find((b) => b.type === 'actions');
      assert.ok(actionsBlock, 'Should have an actions block');
      assert.ok(actionsBlock.elements.length >= 3, 'Should have approve + reject + info buttons');

      const approveBtn = actionsBlock.elements.find((e) =>
        e.action_id?.includes('vigil_approve_')
      );
      assert.ok(approveBtn.action_id.includes('INC-2026-001'));
    });
  });

  // ── postResolutionSummary ──────────────────────────────

  describe('postResolutionSummary', () => {
    it('includes timing metrics', async () => {
      const incident = makeIncident({ resolution: 'pod restarted' });
      const metrics = { totalDurationMs: 45000, stageCount: 5 };
      const result = await postResolutionSummary(incident, metrics);

      assert.equal(result.ok, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      const blocks = callArgs.data.blocks;
      const timingBlock = blocks.find((b) =>
        b.text?.text?.includes('Timing')
      );
      assert.ok(timingBlock, 'Should have a timing block');
      assert.ok(timingBlock.text.text.includes('45s'));
      assert.ok(timingBlock.text.text.includes('5'));
    });
  });

  // ── postEscalationAlert ────────────────────────────────

  describe('postEscalationAlert', () => {
    it('includes reason and reflection count', async () => {
      const incident = makeIncident();
      const result = await postEscalationAlert(
        incident,
        'Max reflections exceeded',
        { reflectionCount: 3, details: 'Verifier failed 3 times' }
      );

      assert.equal(result.ok, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      const blocks = callArgs.data.blocks;
      const blockTexts = blocks.map((b) =>
        (b.text?.text || '') + (b.fields || []).map((f) => f.text).join(' ')
      ).join(' ');

      assert.ok(blockTexts.includes('Max reflections exceeded'));
      assert.ok(blockTexts.includes('3'));
    });
  });

  // ── verifySlackSignature ───────────────────────────────

  describe('verifySlackSignature', () => {
    it('returns true for valid signature', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signBody(body);
      assert.equal(
        verifySlackSignature('test-signing-secret', timestamp, body, signature),
        true
      );
    });

    it('returns false for tampered body', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signBody(body);
      assert.equal(
        verifySlackSignature('test-signing-secret', timestamp, 'payload=tampered', signature),
        false
      );
    });

    it('returns false for wrong secret', () => {
      const body = 'payload=test';
      const { timestamp, signature } = signBody(body, 'wrong-secret');
      assert.equal(
        verifySlackSignature('test-signing-secret', timestamp, body, signature),
        false
      );
    });

    it('returns false when inputs are missing', () => {
      assert.equal(verifySlackSignature(null, null, null, null), false);
      assert.equal(verifySlackSignature('secret', null, 'body', 'sig'), false);
    });

    it('returns false when body is null', () => {
      assert.equal(verifySlackSignature('test-signing-secret', '12345', null, 'v0=abc'), false);
    });

    it('returns false when timestamp is expired (>300s old)', () => {
      const body = 'payload=test';
      const oldTs = String(Math.floor(Date.now() / 1000) - 400);
      const { signature } = signBody(body, 'test-signing-secret', oldTs);
      assert.equal(
        verifySlackSignature('test-signing-secret', oldTs, body, signature),
        false
      );
    });
  });

  // ── sendSlackMessage Slack ok:false ───────────────────

  describe('sendSlackMessage (via postIncidentNotification)', () => {
    it('throws IntegrationError when Slack returns ok: false', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { ok: false, error: 'channel_not_found' },
        headers: {}
      }));

      await assert.rejects(
        () => postIncidentNotification(makeIncident()),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.ok(err.message.includes('channel_not_found'));
          assert.equal(err.retryable, false);
          return true;
        }
      );
    });

    it('marks rate_limited as retryable', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { ok: false, error: 'rate_limited' },
        headers: {}
      }));

      await assert.rejects(
        () => postIncidentNotification(makeIncident()),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.equal(err.retryable, true);
          return true;
        }
      );
    });

    it('includes retryAfter from response headers on rate_limited', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { ok: false, error: 'rate_limited' },
        headers: { 'retry-after': '30' }
      }));

      await assert.rejects(
        () => postIncidentNotification(makeIncident()),
        (err) => {
          assert.equal(err.retryable, true);
          assert.equal(err.retryAfter, 30);
          return true;
        }
      );
    });
  });

  // ── requireSlackToken ──────────────────────────────────

  describe('requireSlackToken', () => {
    it('throws IntegrationError when SLACK_BOT_TOKEN is missing', async () => {
      const saved = process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_BOT_TOKEN;

      try {
        await assert.rejects(
          () => postIncidentNotification(makeIncident()),
          (err) => {
            assert.equal(err.name, 'IntegrationError');
            assert.ok(err.message.includes('SLACK_BOT_TOKEN'));
            assert.equal(err.retryable, false);
            return true;
          }
        );
      } finally {
        process.env.SLACK_BOT_TOKEN = saved;
      }
    });
  });
});
