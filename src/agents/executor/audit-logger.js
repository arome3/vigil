// Executor audit logger — indexes immutable action records to vigil-actions.
// CRITICAL: this module never throws. Audit write failures are logged but
// must not halt the execution pipeline.

import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('executor-audit');

// ── Retry helper (mirrors src/embeddings/embedding-service.js) ──

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

function isRetryable(err) {
  const status = err.response?.status ?? err.meta?.statusCode;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
      log.warn(`${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Index an audit record to the vigil-actions data stream.
 * Catches all errors internally — callers are guaranteed this will not throw.
 *
 * @param {object} record - Audit record fields (action_id, incident_id, etc.)
 * @returns {Promise<void>}
 */
export async function logAuditRecord(record) {
  const document = {
    '@timestamp': new Date().toISOString(),
    agent_name: 'vigil-executor',
    ...record
  };

  try {
    await withRetry(
      () => client.index({ index: 'vigil-actions', document, refresh: false }),
      `audit-index(${record.action_id})`
    );
    log.info(`Audit record indexed: ${record.action_id} [${record.execution_status}]`);
  } catch (err) {
    log.error(`AUDIT WRITE FAILED for ${record.action_id}: ${err.message}`);
  }
}
