// Circuit breaker — prevents cascading failures by fast-failing
// when a downstream integration is unhealthy.

import { createLogger } from '../utils/logger.js';
import { IntegrationError } from './base-client.js';

const log = createLogger('circuit-breaker');

const FAILURE_THRESHOLD = Number(process.env.VIGIL_BREAKER_FAILURE_THRESHOLD) || 5;
const RESET_TIMEOUT_MS = Number(process.env.VIGIL_BREAKER_RESET_TIMEOUT_MS) || 30_000;

const CLOSED = 'CLOSED';
const OPEN = 'OPEN';
const HALF_OPEN = 'HALF_OPEN';

/** @type {Map<string, {state: string, failures: number, lastFailure: number}>} */
const breakers = new Map();

function getOrCreate(name) {
  if (!breakers.has(name)) {
    breakers.set(name, { state: CLOSED, failures: 0, lastFailure: 0 });
  }
  return breakers.get(name);
}

/**
 * Execute `fn` through the circuit breaker for the named integration.
 *
 * @param {string} name - Integration name
 * @param {Function} fn - Async function to execute
 * @param {object} [opts]
 * @param {number} [opts.failureThreshold] - Override default threshold
 * @param {number} [opts.resetTimeoutMs] - Override default reset timeout
 * @returns {Promise<*>}
 */
export async function execBreaker(name, fn, opts = {}) {
  const threshold = opts.failureThreshold ?? FAILURE_THRESHOLD;
  const resetMs = opts.resetTimeoutMs ?? RESET_TIMEOUT_MS;
  const breaker = getOrCreate(name);

  if (breaker.state === OPEN) {
    if (Date.now() - breaker.lastFailure >= resetMs) {
      breaker.state = HALF_OPEN;
      log.info(`Breaker ${name}: OPEN → HALF_OPEN (probe allowed)`);
    } else {
      throw new IntegrationError(
        `Circuit breaker OPEN for ${name} — fast-failing`,
        { integration: name, retryable: false }
      );
    }
  }

  try {
    const result = await fn();
    if (breaker.state === HALF_OPEN) {
      log.info(`Breaker ${name}: HALF_OPEN → CLOSED (probe succeeded)`);
    }
    breaker.state = CLOSED;
    breaker.failures = 0;
    return result;
  } catch (err) {
    if (err.retryable === true) {
      breaker.failures++;
      breaker.lastFailure = Date.now();

      if (breaker.state === HALF_OPEN || breaker.failures >= threshold) {
        breaker.state = OPEN;
        log.warn(`Breaker ${name}: → OPEN (failures=${breaker.failures})`);
      }
    }
    throw err;
  }
}

/** Inspect breaker state for a named integration. */
export function getBreaker(name) {
  return breakers.get(name) || null;
}

/** Reset breaker state — primarily for test isolation. */
export function resetBreaker(name) {
  breakers.delete(name);
}
