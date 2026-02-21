// Shared HTTP request and retry logic for all external integrations.
// Provides IntegrationError, httpRequest, withRetry, and sleep.

import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { execBreaker } from './circuit-breaker.js';

const log = createLogger('integration-http');

const MAX_ATTEMPTS = Number(process.env.VIGIL_INTEGRATION_RETRY_ATTEMPTS) || 3;
const DEFAULT_TIMEOUT_MS = Number(process.env.VIGIL_INTEGRATION_TIMEOUT_MS) || 10_000;

/**
 * Error class for integration failures, carrying retry and status metadata.
 */
export class IntegrationError extends Error {
  constructor(message, { integration, statusCode, retryable = false } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.integration = integration;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify an HTTP status code as retryable or not.
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  if (status === 429) return true;
  if (status >= 500 && status <= 504) return true;
  return false;
}

/**
 * Classify a network error code as retryable.
 * @param {string} code
 * @returns {boolean}
 */
function isRetryableNetworkError(code) {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

/**
 * Make an HTTP request, translating axios errors into IntegrationError.
 *
 * @param {object} opts
 * @param {string} opts.method - HTTP method
 * @param {string} opts.url - Request URL
 * @param {object} [opts.headers] - Request headers
 * @param {*} [opts.data] - Request body
 * @param {number} [opts.timeout] - Timeout in ms (default from env)
 * @returns {Promise<{status: number, data: *, headers: object}>}
 */
export async function httpRequest({ method, url, headers, data, timeout }) {
  try {
    const response = await axios({
      method,
      url,
      headers,
      data,
      timeout: timeout || DEFAULT_TIMEOUT_MS
    });
    return { status: response.status, data: response.data, headers: response.headers };
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const retryable = isRetryableStatus(status);
      const retryAfter = status === 429
        ? Number(err.response.headers?.['retry-after']) || undefined
        : undefined;

      const integrationErr = new IntegrationError(
        `HTTP ${status}: ${err.message}`,
        { statusCode: status, retryable }
      );
      integrationErr.retryAfter = retryAfter;
      throw integrationErr;
    }

    if (err.code && isRetryableNetworkError(err.code)) {
      throw new IntegrationError(
        `Network error (${err.code}): ${err.message}`,
        { retryable: true }
      );
    }

    throw new IntegrationError(err.message, { retryable: false });
  }
}

/**
 * Retry a function with exponential backoff.
 * Only retries when the thrown error has `retryable === true`.
 * Respects `retryAfter` (in seconds) on 429 responses.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts] - Maximum attempts (default from env)
 * @param {number} [opts.baseDelayMs] - Base delay in ms (default 500)
 * @returns {Promise<*>} Result of fn()
 */
export async function withRetry(fn, { maxAttempts, baseDelayMs = 500, integration } = {}) {
  const attempts = Math.max(1, maxAttempts ?? MAX_ATTEMPTS);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (integration && err instanceof IntegrationError && !err.integration) {
        err.integration = integration;
      }
      const isLastAttempt = attempt === attempts;
      if (isLastAttempt || err.retryable !== true) throw err;

      const delay = err.retryAfter
        ? err.retryAfter * 1000
        : baseDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);

      log.warn(
        `Attempt ${attempt}/${attempts} failed (${err.message}), retrying in ${Math.round(delay)}ms`
      );
      await sleep(delay);
    }
  }
}

/**
 * Execute a function with circuit breaker protection wrapping retry logic.
 * When the breaker is OPEN, fails immediately — no retries attempted.
 *
 * @param {string} integration - Integration name for breaker state
 * @param {Function} fn - Async function to execute
 * @param {object} [opts] - withRetry options + breaker overrides
 * @returns {Promise<*>} Result of fn()
 */
export async function withBreaker(integration, fn, opts = {}) {
  const { maxAttempts, baseDelayMs, ...breakerOpts } = opts;
  return execBreaker(
    integration,
    () => withRetry(fn, { maxAttempts, baseDelayMs, integration }),
    breakerOpts
  );
}
