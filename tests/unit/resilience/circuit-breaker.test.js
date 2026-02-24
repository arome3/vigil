import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker, CircuitBreakerOpenError } from '../../../src/resilience/circuit-breaker.js';

// ─── Helpers ──────────────────────────────────────────────────

const FAST_OPTS = { failureThreshold: 3, windowMs: 60_000, recoveryMs: 50 };

function failWith(msg = 'boom') {
  return async () => { throw new Error(msg); };
}

// ─── Basic state transitions ──────────────────────────────────

describe('CircuitBreaker', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', FAST_OPTS);
  });

  it('starts in CLOSED state', () => {
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.failureCount, 0);
  });

  it('passes through successful operations in CLOSED state', async () => {
    const result = await breaker.execute(async () => 42);
    assert.equal(result, 42);
    assert.equal(breaker.state, 'CLOSED');
  });

  it('records failures but stays CLOSED below threshold', async () => {
    await assert.rejects(() => breaker.execute(failWith()));
    await assert.rejects(() => breaker.execute(failWith()));
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.failureCount, 2);
  });

  it('transitions CLOSED -> OPEN at threshold', async () => {
    await assert.rejects(() => breaker.execute(failWith()));
    await assert.rejects(() => breaker.execute(failWith()));
    await assert.rejects(() => breaker.execute(failWith()));
    assert.equal(breaker.state, 'OPEN');
  });

  it('fast-fails with CircuitBreakerOpenError when OPEN', async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(failWith()));
    }
    assert.equal(breaker.state, 'OPEN');

    await assert.rejects(
      () => breaker.execute(async () => 'should not run'),
      (err) => {
        assert(err instanceof CircuitBreakerOpenError);
        assert.equal(err.breakerName, 'test');
        assert(err.remainingMs >= 0);
        return true;
      }
    );
  });
});

// ─── HALF_OPEN probe ──────────────────────────────────────────

describe('HALF_OPEN recovery', () => {
  it('transitions OPEN -> HALF_OPEN -> CLOSED on successful probe', async () => {
    const breaker = new CircuitBreaker('recovery', { ...FAST_OPTS, recoveryMs: 20 });

    // Trip to OPEN
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(failWith()));
    }
    assert.equal(breaker.state, 'OPEN');

    // Wait for recovery period
    await new Promise(r => setTimeout(r, 30));

    // Probe succeeds -> CLOSED
    const result = await breaker.execute(async () => 'recovered');
    assert.equal(result, 'recovered');
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.failureCount, 0);
  });

  it('transitions HALF_OPEN -> OPEN on failed probe', async () => {
    const breaker = new CircuitBreaker('probe-fail', { ...FAST_OPTS, recoveryMs: 20 });

    // Trip to OPEN
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(failWith()));
    }

    // Wait for recovery period
    await new Promise(r => setTimeout(r, 30));

    // Probe fails -> back to OPEN
    await assert.rejects(() => breaker.execute(failWith()));
    assert.equal(breaker.state, 'OPEN');
  });
});

// ─── Concurrent probe guard ──────────────────────────────────

describe('concurrent probe protection', () => {
  it('only allows one probe at a time in HALF_OPEN', async () => {
    const breaker = new CircuitBreaker('concurrent', { ...FAST_OPTS, recoveryMs: 20 });

    // Trip to OPEN
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(failWith()));
    }

    // Wait for recovery period
    await new Promise(r => setTimeout(r, 30));

    // Launch a slow probe and a concurrent call
    const slowProbe = breaker.execute(async () => {
      await new Promise(r => setTimeout(r, 50));
      return 'probe-ok';
    });

    // Second call should fast-fail while probe is in flight
    await assert.rejects(
      () => breaker.execute(async () => 'should not run'),
      (err) => {
        assert(err instanceof CircuitBreakerOpenError);
        return true;
      }
    );

    // Original probe should succeed
    const result = await slowProbe;
    assert.equal(result, 'probe-ok');
    assert.equal(breaker.state, 'CLOSED');
  });
});

// ─── Sliding window ──────────────────────────────────────────

describe('sliding window', () => {
  it('prunes old failures outside the window', async () => {
    const breaker = new CircuitBreaker('window', { failureThreshold: 3, windowMs: 50, recoveryMs: 20 });

    // 2 failures
    await assert.rejects(() => breaker.execute(failWith()));
    await assert.rejects(() => breaker.execute(failWith()));
    assert.equal(breaker.state, 'CLOSED');

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));

    // Old failures pruned — 1 new failure shouldn't trip
    await assert.rejects(() => breaker.execute(failWith()));
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.failureCount, 1);
  });

  it('successes do NOT clear failure window in CLOSED state', async () => {
    const breaker = new CircuitBreaker('no-clear', FAST_OPTS);

    await assert.rejects(() => breaker.execute(failWith()));
    await breaker.execute(async () => 'ok');
    assert.equal(breaker.failureCount, 1); // not cleared
  });
});

// ─── reset() ──────────────────────────────────────────────────

describe('reset()', () => {
  it('resets breaker to clean CLOSED state', async () => {
    const breaker = new CircuitBreaker('reset-test', FAST_OPTS);

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(failWith()));
    }
    assert.equal(breaker.state, 'OPEN');

    breaker.reset();
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.failureCount, 0);

    const result = await breaker.execute(async () => 'after-reset');
    assert.equal(result, 'after-reset');
  });
});

// ─── toJSON() ─────────────────────────────────────────────────

describe('toJSON()', () => {
  it('returns diagnostic snapshot', async () => {
    const breaker = new CircuitBreaker('json-test', FAST_OPTS);
    await assert.rejects(() => breaker.execute(failWith()));

    const snap = breaker.toJSON();
    assert.equal(snap.name, 'json-test');
    assert.equal(snap.state, 'CLOSED');
    assert.equal(snap.failureCount, 1);
    assert.equal(snap.failureThreshold, 3);
    assert.equal(snap.windowMs, 60_000);
    assert.equal(snap.recoveryMs, 50);
  });
});
