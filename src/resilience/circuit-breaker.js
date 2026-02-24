// Agent-level circuit breaker with sliding window failure tracking.
//
// This module is distinct from src/integrations/circuit-breaker.js which uses
// consecutive failure counting for integration-level HTTP calls.
//
// This module uses a time-windowed approach: failures are timestamped and pruned
// when they fall outside the window. This is more appropriate for agent-level
// operations (ES|QL tool calls, A2A delegations) that execute infrequently.
//
// Design note: We use count-based thresholds (not percentage-based like Opossum/Hystrix)
// because agent operations run at low volume (10s-100s/hour, not 1000s/second).
// At low volumes, percentage-based thresholds are unstable — 2/3 failures = 66%
// even during normal operation. If agent call volume increases significantly,
// consider migrating to percentage-based with rolling window buckets.

import { createLogger } from '../utils/logger.js';

const log = createLogger('resilience:circuit-breaker');

// ─── CircuitBreakerOpenError ─────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
  /**
   * @param {string} name - Circuit breaker name
   * @param {number} remainingMs - Milliseconds until recovery probe is allowed
   */
  constructor(name, remainingMs) {
    super(`Circuit breaker "${name}" is OPEN — fast-failing (recovery in ${Math.round(remainingMs / 1000)}s)`);
    this.name = 'CircuitBreakerOpenError';
    this.breakerName = name;
    this.remainingMs = remainingMs;
  }
}

// ─── State constants ─────────────────────────────────────────────

const CLOSED = 'CLOSED';
const OPEN = 'OPEN';
const HALF_OPEN = 'HALF_OPEN';

// ─── CircuitBreaker class ────────────────────────────────────────

export class CircuitBreaker {
  /**
   * @param {string} name - Unique identifier for this breaker
   * @param {Object} [opts]
   * @param {number} [opts.failureThreshold=3] - Failures within window to trip
   * @param {number} [opts.windowMs=300000] - Sliding window duration (default 5 min)
   * @param {number} [opts.recoveryMs=60000] - Time in OPEN before allowing probe (default 1 min)
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 300_000;
    this.recoveryMs = opts.recoveryMs ?? 60_000;

    this._state = CLOSED;
    this._failures = [];     // Array of timestamps (ms)
    this._openedAt = 0;      // When the breaker tripped to OPEN
    this._probing = false;   // Guards against concurrent HALF_OPEN probes
  }

  /** Current state: CLOSED, OPEN, or HALF_OPEN */
  get state() {
    return this._state;
  }

  /** Number of failures within the current window */
  get failureCount() {
    this._pruneWindow();
    return this._failures.length;
  }

  /**
   * Execute an async operation through the circuit breaker.
   *
   * @param {Function} fn - Async function to execute
   * @returns {Promise<*>} Result of fn()
   * @throws {CircuitBreakerOpenError} If breaker is OPEN and recovery period hasn't elapsed
   */
  async execute(fn) {
    let isProber = false;

    // OPEN state: check if recovery period has elapsed
    if (this._state === OPEN) {
      const elapsed = Date.now() - this._openedAt;
      if (elapsed >= this.recoveryMs && !this._probing) {
        this._state = HALF_OPEN;
        this._probing = true;
        isProber = true;
        log.info(`Breaker "${this.name}": OPEN -> HALF_OPEN (probe allowed after ${Math.round(elapsed / 1000)}s)`);
      } else {
        const remaining = this._probing ? this.recoveryMs : this.recoveryMs - elapsed;
        throw new CircuitBreakerOpenError(this.name, Math.max(0, remaining));
      }
    }

    // HALF_OPEN but another caller is already probing — fast-fail
    if (this._state === HALF_OPEN && !isProber) {
      throw new CircuitBreakerOpenError(this.name, 0);
    }

    try {
      const result = await fn();

      // Success handling per state
      if (this._state === HALF_OPEN) {
        log.info(`Breaker "${this.name}": HALF_OPEN -> CLOSED (probe succeeded)`);
        this._state = CLOSED;
        this._failures = [];
        this._probing = false;
      }
      // In CLOSED state, successes do NOT clear failures — the sliding window
      // handles natural aging. This differs from the integrations breaker which
      // resets on any success.

      return result;
    } catch (err) {
      this._recordFailure();
      throw err;
    }
  }

  /** Reset the breaker to CLOSED with no recorded failures. Primarily for testing. */
  reset() {
    this._state = CLOSED;
    this._failures = [];
    this._openedAt = 0;
    this._probing = false;
  }

  /** Get diagnostic snapshot for monitoring/logging. */
  toJSON() {
    this._pruneWindow();
    return {
      name: this.name,
      state: this._state,
      failureCount: this._failures.length,
      failureThreshold: this.failureThreshold,
      windowMs: this.windowMs,
      recoveryMs: this.recoveryMs,
      openedAt: this._openedAt || null
    };
  }

  // ─── Internal methods ────────────────────────────────────────

  _recordFailure() {
    const now = Date.now();

    if (this._state === HALF_OPEN) {
      // Probe failed — go back to OPEN
      this._state = OPEN;
      this._openedAt = now;
      this._probing = false;
      log.warn(`Breaker "${this.name}": HALF_OPEN -> OPEN (probe failed)`);
      return;
    }

    // CLOSED state: record failure timestamp
    this._failures.push(now);
    this._pruneWindow();

    if (this._failures.length >= this.failureThreshold) {
      this._state = OPEN;
      this._openedAt = now;
      log.warn(
        `Breaker "${this.name}": CLOSED -> OPEN ` +
        `(${this._failures.length} failures in ${Math.round(this.windowMs / 1000)}s window)`
      );
    }
  }

  _pruneWindow() {
    const cutoff = Date.now() - this.windowMs;
    // Remove failures older than the window. Since timestamps are monotonically
    // increasing, we can find the first valid index and slice.
    let firstValid = 0;
    while (firstValid < this._failures.length && this._failures[firstValid] < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this._failures = this._failures.slice(firstValid);
    }
  }
}
