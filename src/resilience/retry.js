// Agent-level retry with configurable backoff strategies and per-operation timeouts.
//
// This module is distinct from:
//   - src/utils/retry.js — Elasticsearch client retries (HTTP status code based)
//   - src/integrations/base-client.js — Integration retries (IntegrationError.retryable based)
//
// This module targets agent-level operations: ES|QL tool execution, A2A delegation,
// LLM inference, and workflow webhooks. Adds per-operation timeout via Promise.race
// and configurable backoff strategies (exponential/fixed).

import { createLogger } from '../utils/logger.js';

const log = createLogger('resilience:retry');

// ─── RetryError ───────────────────────────────────────────────────

export class RetryError extends Error {
  /**
   * @param {string} operationName
   * @param {number} attempts - Total attempts made
   * @param {Error} lastError - The final error that caused exhaustion
   */
  constructor(operationName, attempts, lastError) {
    super(`${operationName} failed after ${attempts} attempts: ${lastError.message}`);
    this.name = 'RetryError';
    this.operationName = operationName;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// ─── Preset configurations ───────────────────────────────────────

/**
 * Pre-configured retry presets for common agent operations.
 * Backoff sequences:
 *   esql:     1s, 2s, 4s  (exponential, multiplier=2)
 *   webhook:  2s, 8s      (exponential, multiplier=4)
 *   llm:      1s, 3s, 9s  (exponential, multiplier=3)
 *   a2a:      5s, 5s, 5s  (fixed)
 */
export const RETRY_CONFIGS = Object.freeze({
  esql: Object.freeze({
    maxRetries: 3,
    backoffStrategy: 'exponential',
    baseDelay: 1000,
    multiplier: 2,
    timeout: 30_000,
    operationName: 'ES|QL query',
    isRetryable: defaultIsRetryable
  }),
  webhook: Object.freeze({
    maxRetries: 2,
    backoffStrategy: 'exponential',
    baseDelay: 2000,
    multiplier: 4,
    timeout: 15_000,
    operationName: 'Workflow webhook',
    isRetryable: defaultIsRetryable
  }),
  llm: Object.freeze({
    maxRetries: 3,
    backoffStrategy: 'exponential',
    baseDelay: 1000,
    multiplier: 3,
    timeout: 120_000,
    operationName: 'LLM inference',
    isRetryable: defaultIsRetryable
  }),
  a2a: Object.freeze({
    maxRetries: 3,
    backoffStrategy: 'fixed',
    baseDelay: 5000,
    multiplier: 1,
    timeout: 60_000,
    operationName: 'A2A delegation',
    isRetryable: defaultIsRetryable
  })
});

// ─── Default retryability check ──────────────────────────────────

function defaultIsRetryable(err) {
  // Timeout errors are always retryable
  if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return true;

  // HTTP status-based
  const status = err.status ?? err.statusCode ?? err.response?.status ?? err.meta?.statusCode;
  if (status === 429) return true;                   // Rate limited
  if (status >= 500 && status < 600) return true;    // Server errors

  // Explicit retryable flag (from IntegrationError or similar)
  if (err.retryable === true) return true;

  return false;
}

// ─── Backoff calculation ─────────────────────────────────────────

function computeDelay(attempt, config) {
  if (config.backoffStrategy === 'fixed') {
    return config.baseDelay;
  }
  // Exponential: baseDelay * multiplier^attempt
  return config.baseDelay * Math.pow(config.multiplier, attempt);
}

// ─── Main retry function ─────────────────────────────────────────

/**
 * Execute an async operation with retry and per-operation timeout.
 *
 * When timeout is set, each attempt gets a fresh AbortController. The operation
 * receives `{ signal }` as its first argument so it can wire up cancellation
 * (e.g., pass signal to fetch). On timeout, the signal is aborted to prevent
 * orphaned in-flight operations from producing duplicate side effects.
 *
 * @param {Function} operation - Async function: (opts?: { signal: AbortSignal }) => Promise<*>
 * @param {Object} config - Retry configuration (use RETRY_CONFIGS presets or custom)
 * @param {number} config.maxRetries - Maximum retry attempts (total calls = maxRetries + 1)
 * @param {string} config.backoffStrategy - 'exponential' or 'fixed'
 * @param {number} config.baseDelay - Base delay in ms before first retry
 * @param {number} config.multiplier - Backoff multiplier (exponential only)
 * @param {number} [config.timeout] - Per-attempt timeout in ms (0 = no timeout)
 * @param {string} [config.operationName='operation'] - Label for log messages
 * @param {Function} [config.isRetryable] - Predicate: (err) => boolean
 * @returns {Promise<*>} Result of operation()
 * @throws {RetryError} When all retries exhausted
 */
export async function withRetry(operation, config) {
  const {
    maxRetries,
    backoffStrategy,
    baseDelay,
    multiplier,
    timeout = 0,
    operationName = 'operation',
    isRetryable = defaultIsRetryable
  } = config;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = timeout > 0 ? new AbortController() : null;
    try {
      const result = timeout > 0
        ? await raceWithTimeout(() => operation({ signal: controller.signal }), timeout, operationName, controller)
        : await operation();

      if (attempt > 0) {
        log.info(`${operationName} succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (err) {
      // Abort the in-flight operation on timeout so it doesn't produce side effects
      controller?.abort();
      lastError = err;

      if (attempt === maxRetries || !isRetryable(err)) {
        break;
      }

      const delay = computeDelay(attempt, { backoffStrategy, baseDelay, multiplier });
      log.warn(
        `${operationName} attempt ${attempt + 1}/${maxRetries + 1} failed (${err.message}), ` +
        `retrying in ${delay}ms [strategy=${backoffStrategy}]`
      );

      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new RetryError(operationName, maxRetries + 1, lastError);
}

// ─── Timeout racing ──────────────────────────────────────────────

function raceWithTimeout(operation, timeoutMs, operationName, controller) {
  let handle;
  const timeoutPromise = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const err = new Error(`${operationName} timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      // Abort the in-flight operation before rejecting
      controller?.abort();
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([operation(), timeoutPromise]).finally(() => {
    clearTimeout(handle);
  });
}
