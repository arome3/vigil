import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { withRetry, RetryError, RETRY_CONFIGS } from '../../../src/resilience/retry.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeFailingOp(failCount, result = 'ok') {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      if (calls <= failCount) {
        const err = new Error(`fail #${calls}`);
        err.status = 503;
        throw err;
      }
      return result;
    },
    getCalls: () => calls
  };
}

const FAST_CONFIG = {
  maxRetries: 3,
  backoffStrategy: 'exponential',
  baseDelay: 10,
  multiplier: 2,
  timeout: 0,
  operationName: 'test-op',
};

// ─── Basic retry behavior ─────────────────────────────────────

describe('withRetry', () => {
  it('returns result on first-try success', async () => {
    const result = await withRetry(async () => 42, FAST_CONFIG);
    assert.equal(result, 42);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    const op = makeFailingOp(2, 'recovered');
    const result = await withRetry(op.fn, FAST_CONFIG);
    assert.equal(result, 'recovered');
    assert.equal(op.getCalls(), 3); // 2 failures + 1 success
  });

  it('throws RetryError after exhausting retries', async () => {
    const op = makeFailingOp(10, 'never');
    await assert.rejects(
      () => withRetry(op.fn, FAST_CONFIG),
      (err) => {
        assert(err instanceof RetryError);
        assert.equal(err.operationName, 'test-op');
        assert.equal(err.attempts, 4); // maxRetries(3) + 1
        assert.match(err.message, /test-op failed after 4 attempts/);
        return true;
      }
    );
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      const err = new Error('not retryable');
      err.status = 400; // client error — not retryable
      throw err;
    };
    await assert.rejects(() => withRetry(op, FAST_CONFIG));
    assert.equal(calls, 1); // no retry
  });
});

// ─── Backoff strategies ───────────────────────────────────────

describe('backoff strategies', () => {
  it('uses fixed delay for fixed strategy', async () => {
    const config = { ...FAST_CONFIG, backoffStrategy: 'fixed', baseDelay: 5 };
    const op = makeFailingOp(2, 'ok');
    const start = Date.now();
    await withRetry(op.fn, config);
    const elapsed = Date.now() - start;
    // 2 retries at 5ms each ≈ 10ms minimum
    assert(elapsed >= 8, `Expected >= 8ms, got ${elapsed}ms`);
  });

  it('uses exponential delay for exponential strategy', async () => {
    const config = { ...FAST_CONFIG, backoffStrategy: 'exponential', baseDelay: 10, multiplier: 2 };
    const op = makeFailingOp(2, 'ok');
    const start = Date.now();
    await withRetry(op.fn, config);
    const elapsed = Date.now() - start;
    // 10ms (2^0) + 20ms (2^1) = 30ms minimum
    assert(elapsed >= 25, `Expected >= 25ms, got ${elapsed}ms`);
  });
});

// ─── Timeout behavior ─────────────────────────────────────────

describe('timeout', () => {
  it('rejects with TimeoutError when operation exceeds timeout', async () => {
    const config = { ...FAST_CONFIG, timeout: 50, maxRetries: 0 };
    const slowOp = async () => {
      await new Promise(r => setTimeout(r, 200));
      return 'too late';
    };
    await assert.rejects(
      () => withRetry(slowOp, config),
      (err) => {
        assert(err instanceof RetryError);
        assert.equal(err.lastError.name, 'TimeoutError');
        return true;
      }
    );
  });

  it('succeeds when operation completes within timeout', async () => {
    const config = { ...FAST_CONFIG, timeout: 500 };
    const result = await withRetry(async () => 'fast', config);
    assert.equal(result, 'fast');
  });

  it('passes AbortSignal to operation', async () => {
    let receivedSignal = null;
    const config = { ...FAST_CONFIG, timeout: 500, maxRetries: 0 };
    await withRetry(async ({ signal }) => {
      receivedSignal = signal;
      return 'ok';
    }, config);
    assert(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, false);
  });

  it('aborts signal on timeout before retrying', async () => {
    const signals = [];
    const config = { ...FAST_CONFIG, timeout: 30, maxRetries: 1, baseDelay: 5 };
    let calls = 0;
    const op = async ({ signal }) => {
      signals.push(signal);
      calls++;
      if (calls === 1) {
        await new Promise(r => setTimeout(r, 100)); // exceed timeout
      }
      return 'ok';
    };
    await withRetry(op, config);
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true); // first signal was aborted
  });
});

// ─── RETRY_CONFIGS presets ────────────────────────────────────

describe('RETRY_CONFIGS', () => {
  it('has all expected presets', () => {
    assert.deepEqual(Object.keys(RETRY_CONFIGS).sort(), ['a2a', 'esql', 'llm', 'webhook']);
  });

  it('esql preset has correct backoff sequence', () => {
    const c = RETRY_CONFIGS.esql;
    assert.equal(c.maxRetries, 3);
    assert.equal(c.backoffStrategy, 'exponential');
    assert.equal(c.baseDelay, 1000);
    assert.equal(c.multiplier, 2);
  });

  it('a2a preset uses fixed backoff', () => {
    const c = RETRY_CONFIGS.a2a;
    assert.equal(c.backoffStrategy, 'fixed');
    assert.equal(c.baseDelay, 5000);
  });

  it('presets are frozen', () => {
    assert.throws(() => { RETRY_CONFIGS.esql.maxRetries = 99; }, TypeError);
  });
});
