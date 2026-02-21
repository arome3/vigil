import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock setup ─────────────────────────────────────────────

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

// We need IntegrationError from base-client, but base-client imports circuit-breaker.
// Mock axios to allow base-client to load, then import both.
mock.module('axios', { defaultExport: mock.fn() });

const { IntegrationError } = await import('../../../src/integrations/base-client.js');
const { execBreaker, getBreaker, resetBreaker } =
  await import('../../../src/integrations/circuit-breaker.js');

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/circuit-breaker', () => {
  beforeEach(() => {
    resetBreaker('test');
  });

  it('passes through in CLOSED state', async () => {
    const result = await execBreaker('test', async () => 'ok');
    assert.equal(result, 'ok');

    const state = getBreaker('test');
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.failures, 0);
  });

  it('does NOT count non-retryable errors toward threshold', async () => {
    for (let i = 0; i < 10; i++) {
      try {
        await execBreaker('test', async () => {
          throw new IntegrationError('bad request', { retryable: false });
        }, { failureThreshold: 3 });
      } catch { /* expected */ }
    }

    const state = getBreaker('test');
    assert.equal(state.state, 'CLOSED', 'Non-retryable errors should not open the breaker');
    assert.equal(state.failures, 0);
  });

  it('opens after failureThreshold retryable errors', async () => {
    const threshold = 3;

    for (let i = 0; i < threshold; i++) {
      try {
        await execBreaker('test', async () => {
          throw new IntegrationError('timeout', { retryable: true });
        }, { failureThreshold: threshold });
      } catch { /* expected */ }
    }

    const state = getBreaker('test');
    assert.equal(state.state, 'OPEN');
    assert.equal(state.failures, threshold);
  });

  it('fast-fails when OPEN (fn never called)', async () => {
    // First, open the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await execBreaker('test', async () => {
          throw new IntegrationError('fail', { retryable: true });
        }, { failureThreshold: 3 });
      } catch { /* expected */ }
    }

    // Now verify fast-fail
    const fn = mock.fn(async () => 'should not be called');

    await assert.rejects(
      () => execBreaker('test', fn, { failureThreshold: 3, resetTimeoutMs: 60_000 }),
      (err) => {
        assert.equal(err.name, 'IntegrationError');
        assert.ok(err.message.includes('Circuit breaker OPEN'));
        assert.equal(err.retryable, false);
        return true;
      }
    );

    assert.equal(fn.mock.callCount(), 0, 'fn should not be called when OPEN');
  });

  it('transitions to HALF_OPEN after resetTimeout expires', async () => {
    // Open the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await execBreaker('test', async () => {
          throw new IntegrationError('fail', { retryable: true });
        }, { failureThreshold: 3, resetTimeoutMs: 1 });
      } catch { /* expected */ }
    }

    // Wait for reset timeout to expire
    await new Promise(r => setTimeout(r, 10));

    // Should transition to HALF_OPEN and allow the probe
    const result = await execBreaker('test', async () => 'recovered', {
      failureThreshold: 3,
      resetTimeoutMs: 1
    });

    assert.equal(result, 'recovered');
    const state = getBreaker('test');
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.failures, 0);
  });

  it('re-opens on HALF_OPEN probe failure', async () => {
    // Open the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await execBreaker('test', async () => {
          throw new IntegrationError('fail', { retryable: true });
        }, { failureThreshold: 3, resetTimeoutMs: 1 });
      } catch { /* expected */ }
    }

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 10));

    // Probe fails — should re-open
    try {
      await execBreaker('test', async () => {
        throw new IntegrationError('still failing', { retryable: true });
      }, { failureThreshold: 3, resetTimeoutMs: 1 });
    } catch { /* expected */ }

    const state = getBreaker('test');
    assert.equal(state.state, 'OPEN');
  });

  it('resets failures to 0 on success', async () => {
    // Accumulate some failures (but not enough to open)
    for (let i = 0; i < 2; i++) {
      try {
        await execBreaker('test', async () => {
          throw new IntegrationError('fail', { retryable: true });
        }, { failureThreshold: 5 });
      } catch { /* expected */ }
    }

    assert.equal(getBreaker('test').failures, 2);

    // Success should reset
    await execBreaker('test', async () => 'ok', { failureThreshold: 5 });

    assert.equal(getBreaker('test').failures, 0);
  });

  it('resetBreaker clears state', async () => {
    await execBreaker('test', async () => 'ok');
    assert.ok(getBreaker('test'));

    resetBreaker('test');
    assert.equal(getBreaker('test'), null);
  });
});
