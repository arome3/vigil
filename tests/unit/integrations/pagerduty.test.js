import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Environment variables (must be set before import) ──────
process.env.PAGERDUTY_ROUTING_KEY = 'test-routing-key';

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

const { triggerIncident, resolveIncident, SEVERITY_MAP } =
  await import('../../../src/integrations/pagerduty.js');

// ─── Helpers ────────────────────────────────────────────────

function mockPDSuccess(overrides = {}) {
  mockAxios.mock.resetCalls();
  mockAxios.mock.mockImplementation(async () => ({
    status: 202,
    data: { status: 'success', dedup_key: 'vigil-INC-001', ...overrides },
    headers: {}
  }));
}

function makeIncident(overrides = {}) {
  return {
    incident_id: 'INC-2026-001',
    severity: 'critical',
    type: 'brute-force',
    service: 'auth-service',
    ...overrides
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/pagerduty', () => {
  beforeEach(() => {
    mockPDSuccess();
  });

  // ── triggerIncident ─────────────────────────────────────

  describe('triggerIncident', () => {
    it('sends correct routing key and dedup_key format', async () => {
      const incident = makeIncident();
      const result = await triggerIncident(incident, 'Max reflections exceeded');

      assert.equal(result.status, 'success');
      assert.equal(result.dedup_key, 'vigil-INC-2026-001');

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.data.routing_key, 'test-routing-key');
      assert.equal(callArgs.data.dedup_key, 'vigil-INC-2026-001');
      assert.equal(callArgs.data.event_action, 'trigger');
    });

    it('maps severity correctly', async () => {
      for (const [vigil, pd] of Object.entries(SEVERITY_MAP)) {
        mockPDSuccess();
        await triggerIncident(makeIncident({ severity: vigil }), 'test');

        const callArgs = mockAxios.mock.calls[0].arguments[0];
        assert.equal(callArgs.data.payload.severity, pd,
          `${vigil} should map to ${pd}`);
      }
    });

    it('includes custom details in payload', async () => {
      const incident = makeIncident();
      const custom = { affectedUsers: 42, region: 'us-east-1' };
      await triggerIncident(incident, 'test reason', custom);

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.data.payload.custom_details.affectedUsers, 42);
      assert.equal(callArgs.data.payload.custom_details.region, 'us-east-1');
    });

    it('retries on 500 response', async () => {
      let callCount = 0;
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('server error');
          err.response = { status: 500, headers: {} };
          throw err;
        }
        return {
          status: 202,
          data: { status: 'success', dedup_key: 'vigil-INC-2026-001' },
          headers: {}
        };
      });

      const result = await triggerIncident(makeIncident(), 'test');
      assert.equal(result.status, 'success');
      assert.equal(callCount, 2);
    });

    it('does not retry on 400 response', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => {
        const err = new Error('bad request');
        err.response = { status: 400, headers: {} };
        throw err;
      });

      await assert.rejects(
        () => triggerIncident(makeIncident(), 'test'),
        (err) => {
          assert.equal(err.retryable, false);
          return true;
        }
      );

      assert.equal(mockAxios.mock.callCount(), 1, 'Should not retry 400');
    });
  });

  // ── resolveIncident ─────────────────────────────────────

  describe('resolveIncident', () => {
    it('sends resolve event with same dedup_key', async () => {
      const result = await resolveIncident('INC-2026-001');

      assert.equal(result.status, 'success');
      assert.equal(result.dedup_key, 'vigil-INC-2026-001');

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.equal(callArgs.data.event_action, 'resolve');
      assert.equal(callArgs.data.dedup_key, 'vigil-INC-2026-001');
      assert.equal(callArgs.data.routing_key, 'test-routing-key');
    });
  });

  // ── requireRoutingKey ─────────────────────────────────

  describe('requireRoutingKey', () => {
    it('throws IntegrationError when PAGERDUTY_ROUTING_KEY is missing', async () => {
      const saved = process.env.PAGERDUTY_ROUTING_KEY;
      delete process.env.PAGERDUTY_ROUTING_KEY;

      try {
        await assert.rejects(
          () => triggerIncident(makeIncident(), 'test'),
          (err) => {
            assert.equal(err.name, 'IntegrationError');
            assert.ok(err.message.includes('PAGERDUTY_ROUTING_KEY'));
            assert.equal(err.retryable, false);
            return true;
          }
        );
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = saved;
      }
    });
  });
});
