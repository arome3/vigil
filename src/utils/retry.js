import { createLogger } from './logger.js';

const log = createLogger('utils:retry');

/**
 * Check whether an error is retryable (429 or 5xx).
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  const status = err.response?.status ?? err.meta?.statusCode;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Retry an async function with exponential backoff + jitter.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [options]
 * @param {string} [options.label='operation'] - Label for log messages
 * @param {number} [options.maxRetries=2] - Max retry attempts (total calls = maxRetries + 1)
 * @param {number} [options.baseDelayMs=500] - Base delay before first retry
 * @returns {Promise<*>} Result of fn()
 */
export async function withRetry(fn, { label = 'operation', maxRetries = 2, baseDelayMs = 500 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isRetryable(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs;
      log.warn(`${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
