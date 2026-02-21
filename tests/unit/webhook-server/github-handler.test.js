import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// ─── Environment variables (must be set before import) ──────
process.env.GITHUB_WEBHOOK_SECRET = 'test-gh-secret';

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

// uuid mock — return predictable IDs for assertion
mock.module('uuid', {
  namedExports: {
    v4: () => 'test-event-uuid'
  }
});

// ─── Import module under test ───────────────────────────────

const { verifyGitHubSignature, handleGitHubWebhook } =
  await import('../../../src/webhook-server/github-handler.js');

// ─── Helpers ────────────────────────────────────────────────

function signPayload(payload, secret = 'test-gh-secret') {
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return `sha256=${sig}`;
}

// ─── Tests ──────────────────────────────────────────────────

describe('webhook-server/github-handler', () => {
  beforeEach(() => {
    mockClientIndex.mock.resetCalls();
    mockClientIndex.mock.mockImplementation(async () => ({ result: 'created' }));
  });

  // ── verifyGitHubSignature ──────────────────────────────

  describe('verifyGitHubSignature', () => {
    it('returns true for valid HMAC signature', () => {
      const body = '{"action":"push"}';
      const sig = signPayload(body);
      assert.equal(verifyGitHubSignature('test-gh-secret', body, sig), true);
    });

    it('returns false for invalid signature', () => {
      const body = '{"action":"push"}';
      const sig = signPayload(body, 'wrong-secret');
      assert.equal(verifyGitHubSignature('test-gh-secret', body, sig), false);
    });

    it('returns false for tampered payload', () => {
      const body = '{"action":"push"}';
      const sig = signPayload(body);
      assert.equal(verifyGitHubSignature('test-gh-secret', '{"action":"tampered"}', sig), false);
    });

    it('returns false when inputs are missing', () => {
      assert.equal(verifyGitHubSignature(null, null, null), false);
      assert.equal(verifyGitHubSignature('secret', 'body', null), false);
    });

    it('handles signature without sha256= prefix', () => {
      const body = '{"action":"push"}';
      const fullSig = signPayload(body);
      const rawHex = fullSig.slice(7); // strip "sha256="
      assert.equal(verifyGitHubSignature('test-gh-secret', body, rawHex), true);
    });
  });

  // ── handleGitHubWebhook ────────────────────────────────

  describe('handleGitHubWebhook', () => {
    it('indexes push events correctly', async () => {
      const payload = {
        ref: 'refs/heads/main',
        repository: { full_name: 'vigil-org/vigil' },
        commits: [{ id: 'abc123' }, { id: 'def456' }],
        head_commit: { id: 'def456', message: 'Fix auth bug' },
        pusher: { name: 'dev-user' }
      };

      const result = await handleGitHubWebhook('push', payload);

      assert.equal(result.indexed, true);
      assert.equal(result.eventId, 'test-event-uuid');

      const indexCall = mockClientIndex.mock.calls[0].arguments[0];
      assert.equal(indexCall.index, 'vigil-github-events');
      assert.equal(indexCall.document.event_type, 'push');
      assert.equal(indexCall.document.repository, 'vigil-org/vigil');
      assert.equal(indexCall.document.branch, 'main');
      assert.equal(indexCall.document.commit_count, 2);
      assert.equal(indexCall.document.pusher, 'dev-user');
    });

    it('indexes deployment events correctly', async () => {
      const payload = {
        deployment: {
          environment: 'production',
          sha: 'abc123',
          creator: { login: 'ci-bot' }
        },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('deployment', payload);

      assert.equal(result.indexed, true);

      const doc = mockClientIndex.mock.calls[0].arguments[0].document;
      assert.equal(doc.event_type, 'deployment');
      assert.equal(doc.environment, 'production');
      assert.equal(doc.sha, 'abc123');
      assert.equal(doc.creator, 'ci-bot');
    });

    it('indexes deployment_status events correctly', async () => {
      const payload = {
        deployment: {
          environment: 'staging',
          sha: 'xyz789',
          creator: { login: 'ci-bot' }
        },
        deployment_status: {
          state: 'success',
          description: 'Deployed successfully'
        },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('deployment_status', payload);

      assert.equal(result.indexed, true);

      const doc = mockClientIndex.mock.calls[0].arguments[0].document;
      assert.equal(doc.event_type, 'deployment_status');
      assert.equal(doc.status, 'success');
    });

    it('indexes merged pull_request events', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          merged: true,
          number: 42,
          title: 'Add auth module',
          merged_by: { login: 'lead-dev' },
          base: { ref: 'main' },
          head: { ref: 'feature/auth' },
          additions: 150,
          deletions: 20,
          changed_files: 5
        },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('pull_request', payload);

      assert.equal(result.indexed, true);

      const doc = mockClientIndex.mock.calls[0].arguments[0].document;
      assert.equal(doc.event_type, 'pull_request_merged');
      assert.equal(doc.pr_number, 42);
      assert.equal(doc.merged_by, 'lead-dev');
    });

    it('ignores non-merged pull_request events', async () => {
      const payload = {
        action: 'opened',
        pull_request: { merged: false, number: 43 },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('pull_request', payload);

      assert.equal(result.indexed, false);
      assert.equal(result.eventId, null);
      assert.equal(mockClientIndex.mock.callCount(), 0);
    });

    it('ignores closed-but-not-merged pull_request events', async () => {
      const payload = {
        action: 'closed',
        pull_request: { merged: false, number: 44 },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('pull_request', payload);

      assert.equal(result.indexed, false);
      assert.equal(mockClientIndex.mock.callCount(), 0);
    });

    it('ignores unhandled event types', async () => {
      const result = await handleGitHubWebhook('star', { action: 'created' });

      assert.equal(result.indexed, false);
      assert.equal(result.eventId, null);
      assert.equal(mockClientIndex.mock.callCount(), 0);
    });

    it('uses explicit event string as event_type, not payload discriminator', async () => {
      // A deployment event should use the event string "deployment"
      // regardless of whether payload contains deployment_status
      const payload = {
        deployment: {
          environment: 'production',
          sha: 'abc123',
          creator: { login: 'ci-bot' }
        },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('deployment', payload);

      assert.equal(result.indexed, true);
      const doc = mockClientIndex.mock.calls[0].arguments[0].document;
      assert.equal(doc.event_type, 'deployment',
        'event_type should come from the event string, not payload inspection');
    });

    it('returns indexed: false on ES failure instead of throwing', async () => {
      mockClientIndex.mock.resetCalls();
      mockClientIndex.mock.mockImplementation(async () => {
        throw new Error('ES connection refused');
      });

      const payload = {
        ref: 'refs/heads/main',
        repository: { full_name: 'vigil-org/vigil' },
        commits: [{ id: 'abc123' }],
        head_commit: { id: 'abc123', message: 'test' },
        pusher: { name: 'dev-user' }
      };

      const result = await handleGitHubWebhook('push', payload);

      assert.equal(result.indexed, false);
      assert.ok(result.error);
      assert.equal(result.eventId, 'test-event-uuid');
    });

    it('deployment_status event uses "deployment_status" as event_type', async () => {
      const payload = {
        deployment: {
          environment: 'staging',
          sha: 'xyz789',
          creator: { login: 'ci-bot' }
        },
        deployment_status: {
          state: 'failure',
          description: 'Deploy failed'
        },
        repository: { full_name: 'vigil-org/vigil' }
      };

      const result = await handleGitHubWebhook('deployment_status', payload);

      assert.equal(result.indexed, true);
      const doc = mockClientIndex.mock.calls[0].arguments[0].document;
      assert.equal(doc.event_type, 'deployment_status',
        'event_type should match the event header, not be derived from payload');
    });
  });
});
