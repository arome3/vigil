import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Environment variables (must be set before import) ──────
process.env.OKTA_DOMAIN = 'dev-12345.okta.com';
process.env.OKTA_OAUTH_TOKEN = 'test-okta-token';

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

const { suspendUser, unsuspendUser, lookupUserByLogin } =
  await import('../../../src/integrations/okta.js');

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/okta', () => {
  beforeEach(() => {
    mockAxios.mock.resetCalls();
  });

  // ── suspendUser ──────────────────────────────────────────

  describe('suspendUser', () => {
    it('sends POST to lifecycle/suspend with Bearer auth', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: {},
        headers: {}
      }));

      const result = await suspendUser('user-001');

      assert.equal(result.success, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.method, 'POST');
      assert.ok(callArgs.url.includes('users/user-001/lifecycle/suspend'));
      assert.ok(callArgs.url.startsWith('https://dev-12345.okta.com/api/v1/'));
      assert.equal(callArgs.headers.Authorization, 'Bearer test-okta-token');
    });
  });

  // ── unsuspendUser ────────────────────────────────────────

  describe('unsuspendUser', () => {
    it('sends POST to lifecycle/unsuspend', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: {},
        headers: {}
      }));

      const result = await unsuspendUser('user-001');

      assert.equal(result.success, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.method, 'POST');
      assert.ok(callArgs.url.includes('users/user-001/lifecycle/unsuspend'));
    });
  });

  // ── lookupUserByLogin ────────────────────────────────────

  describe('lookupUserByLogin', () => {
    it('sends GET with URL-encoded login and returns user data', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: {
          id: 'user-001',
          status: 'ACTIVE',
          profile: { login: 'alice@vigil.io', firstName: 'Alice' }
        },
        headers: {}
      }));

      const result = await lookupUserByLogin('alice@vigil.io');

      assert.equal(result.id, 'user-001');
      assert.equal(result.status, 'ACTIVE');
      assert.equal(result.profile.login, 'alice@vigil.io');

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.method, 'GET');
      assert.ok(callArgs.url.includes('users/alice%40vigil.io'));
    });
  });

  // ── env var validation ───────────────────────────────────

  describe('requireConfig validation', () => {
    it('functions work when env vars are set (smoke test)', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { id: 'user-001', status: 'ACTIVE', profile: {} },
        headers: {}
      }));

      // These should not throw since env vars are set
      await assert.doesNotReject(() => suspendUser('user-001'));
      await assert.doesNotReject(() => unsuspendUser('user-001'));
      await assert.doesNotReject(() => lookupUserByLogin('test@test.com'));
    });

    it('throws IntegrationError when OKTA_DOMAIN is missing', async () => {
      const saved = process.env.OKTA_DOMAIN;
      delete process.env.OKTA_DOMAIN;

      try {
        await assert.rejects(
          () => suspendUser('user-001'),
          (err) => {
            assert.equal(err.name, 'IntegrationError');
            assert.ok(err.message.includes('OKTA_DOMAIN'));
            assert.equal(err.retryable, false);
            return true;
          }
        );
      } finally {
        process.env.OKTA_DOMAIN = saved;
      }
    });
  });
});
