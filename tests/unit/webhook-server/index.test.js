import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// ─── Environment variables (must be set before import) ──────
process.env.GITHUB_WEBHOOK_SECRET = 'test-gh-secret';
process.env.SLACK_SIGNING_SECRET = 'test-slack-secret';

// ─── Mock setup ─────────────────────────────────────────────

const mockHandleGitHub = mock.fn(async () => ({ indexed: true, eventId: 'evt-1' }));
const mockVerifyGitHub = mock.fn(() => true);
const mockVerifySlack = mock.fn(() => true);
const mockHandleApproval = mock.fn(async () => ({
  incidentId: 'INC-001', action: 'approve', updatedBy: 'user', indexed: true
}));

mock.module(import.meta.resolve('../../../src/webhook-server/github-handler.js'), {
  namedExports: {
    handleGitHubWebhook: mockHandleGitHub,
    verifyGitHubSignature: mockVerifyGitHub
  }
});

mock.module(import.meta.resolve('../../../src/integrations/slack.js'), {
  namedExports: {
    verifySlackSignature: mockVerifySlack,
    postIncidentNotification: mock.fn(),
    postApprovalRequest: mock.fn(),
    postResolutionSummary: mock.fn(),
    postEscalationAlert: mock.fn()
  }
});

mock.module(import.meta.resolve('../../../src/webhook-server/approval-handler.js'), {
  namedExports: {
    handleApprovalCallback: mockHandleApproval
  }
});

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: { index: mock.fn() }
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

// ─── Import app under test + supertest ──────────────────────

const { app } = await import('../../../src/webhook-server/index.js');
const supertest = (await import('supertest')).default;

// ─── Helpers ────────────────────────────────────────────────

function signGitHubBody(body, secret = 'test-gh-secret') {
  return 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');
}

// ─── Tests ──────────────────────────────────────────────────

describe('webhook-server/index', () => {
  beforeEach(() => {
    mockHandleGitHub.mock.resetCalls();
    mockVerifyGitHub.mock.resetCalls();
    mockVerifySlack.mock.resetCalls();
    mockHandleApproval.mock.resetCalls();
    mockHandleGitHub.mock.mockImplementation(async () => ({ indexed: true, eventId: 'evt-1' }));
    mockVerifyGitHub.mock.mockImplementation(() => true);
    mockVerifySlack.mock.mockImplementation(() => true);
    mockHandleApproval.mock.mockImplementation(async () => ({
      incidentId: 'INC-001', action: 'approve', updatedBy: 'user', indexed: true
    }));
  });

  // ── GET /health ────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status ok and uptime', async () => {
      const res = await supertest(app).get('/health');

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(typeof res.body.uptime, 'number');
    });
  });

  // ── POST /webhook/github ──────────────────────────────

  describe('POST /webhook/github', () => {
    it('returns 200 with handler result on valid signature', async () => {
      const body = JSON.stringify({ action: 'push' });

      const res = await supertest(app)
        .post('/webhook/github')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signGitHubBody(body))
        .set('x-github-event', 'push')
        .send(body);

      assert.equal(res.status, 200);
      assert.equal(res.body.indexed, true);
    });

    it('returns 401 on invalid signature', async () => {
      mockVerifyGitHub.mock.mockImplementation(() => false);

      const res = await supertest(app)
        .post('/webhook/github')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', 'sha256=invalid')
        .set('x-github-event', 'push')
        .send('{}');

      assert.equal(res.status, 401);
      assert.ok(res.body.error);
    });

    it('returns 500 when handler throws', async () => {
      mockHandleGitHub.mock.mockImplementation(async () => {
        throw new Error('handler boom');
      });

      const body = JSON.stringify({ action: 'push' });

      const res = await supertest(app)
        .post('/webhook/github')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signGitHubBody(body))
        .set('x-github-event', 'push')
        .send(body);

      assert.equal(res.status, 500);
    });
  });

  // ── POST /api/vigil/approval-callback ─────────────────

  describe('POST /api/vigil/approval-callback', () => {
    it('returns 200 with handler result on valid signature', async () => {
      const body = 'payload=%7B%22actions%22%3A%5B%5D%7D';

      const res = await supertest(app)
        .post('/api/vigil/approval-callback')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
        .set('x-slack-signature', 'v0=valid')
        .send(body);

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('returns 401 on invalid Slack signature', async () => {
      mockVerifySlack.mock.mockImplementation(() => false);

      const body = 'payload=%7B%22actions%22%3A%5B%5D%7D';

      const res = await supertest(app)
        .post('/api/vigil/approval-callback')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
        .set('x-slack-signature', 'v0=invalid')
        .send(body);

      assert.equal(res.status, 401);
    });
  });
});
