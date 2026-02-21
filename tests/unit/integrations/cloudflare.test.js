import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Environment variables (must be set before import) ──────
process.env.CLOUDFLARE_API_TOKEN = 'test-cf-token';
process.env.CLOUDFLARE_ZONE_ID = 'zone-123';
process.env.CLOUDFLARE_RULESET_ID = 'ruleset-456';

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

const { blockIP, removeBlockRule } = await import('../../../src/integrations/cloudflare.js');

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/cloudflare', () => {
  beforeEach(() => {
    mockAxios.mock.resetCalls();
  });

  // ── blockIP ─────────────────────────────────────────────

  describe('blockIP', () => {
    it('blocks a single IP with eq expression', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { result: { id: 'rule-001' } },
        headers: {}
      }));

      const result = await blockIP('10.0.0.1', 'INC-001');

      assert.equal(result.success, true);
      assert.equal(result.ruleId, 'rule-001');

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.method, 'POST');
      assert.ok(callArgs.url.includes('/zones/zone-123/rulesets/ruleset-456/rules'));
      assert.equal(callArgs.data.expression, 'ip.src eq 10.0.0.1');
      assert.equal(callArgs.data.action, 'block');
      assert.equal(callArgs.data.enabled, true);
    });

    it('blocks a CIDR range with in expression', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { result: { id: 'rule-002' } },
        headers: {}
      }));

      const result = await blockIP('192.168.1.0/24', 'INC-002');

      assert.equal(result.success, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.data.expression, 'ip.src in {192.168.1.0/24}');
    });

    it('extracts ruleId from rules array fallback', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { result: { rules: [{ id: 'old' }, { id: 'new-rule' }] } },
        headers: {}
      }));

      const result = await blockIP('10.0.0.2', 'INC-003');
      assert.equal(result.ruleId, 'new-rule');
    });

    it('throws IntegrationError when ruleId cannot be extracted', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { result: {} },
        headers: {}
      }));

      await assert.rejects(
        () => blockIP('10.0.0.3', 'INC-004'),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.ok(err.message.includes('rule ID'));
          assert.equal(err.retryable, false);
          return true;
        }
      );
    });

    it('includes Bearer auth header', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { result: { id: 'rule-005' } },
        headers: {}
      }));

      await blockIP('10.0.0.5', 'INC-005');

      const headers = mockAxios.mock.calls[0].arguments[0].headers;
      assert.equal(headers.Authorization, 'Bearer test-cf-token');
    });
  });

  // ── removeBlockRule ─────────────────────────────────────

  describe('removeBlockRule', () => {
    it('sends DELETE to correct URL with ruleId', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: {},
        headers: {}
      }));

      const result = await removeBlockRule('rule-abc');

      assert.equal(result.success, true);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.method, 'DELETE');
      assert.ok(callArgs.url.endsWith('/rules/rule-abc'));
    });

    it('throws IntegrationError on HTTP error', async () => {
      mockAxios.mock.mockImplementation(async () => {
        const err = new Error('Not Found');
        err.response = { status: 404, headers: {} };
        throw err;
      });

      await assert.rejects(
        () => removeBlockRule('rule-nonexistent'),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });
  });

  // ── requireConfig ──────────────────────────────────────

  describe('requireConfig', () => {
    it('throws when CLOUDFLARE_API_TOKEN is missing', async () => {
      const saved = process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.CLOUDFLARE_API_TOKEN;

      try {
        await assert.rejects(
          () => blockIP('10.0.0.1', 'INC-001'),
          (err) => {
            assert.equal(err.name, 'IntegrationError');
            assert.equal(err.retryable, false);
            return true;
          }
        );
      } finally {
        process.env.CLOUDFLARE_API_TOKEN = saved;
      }
    });
  });

  // ── IP/CIDR validation ─────────────────────────────────

  describe('IP/CIDR validation', () => {
    it('throws on invalid IP format', async () => {
      await assert.rejects(
        () => blockIP('not-an-ip', 'INC-001'),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.ok(err.message.includes('Invalid IP or CIDR'));
          assert.equal(err.retryable, false);
          return true;
        }
      );

      assert.equal(mockAxios.mock.callCount(), 0, 'Should not make HTTP call');
    });
  });
});
