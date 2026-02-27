// Polling fallback for the approval gate — polls vigil-approval-responses
// when the Elastic Workflows wait step is unavailable.

import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('polling-fallback');

/** Maximum consecutive polling failures before giving up. */
const DEFAULT_MAX_POLL_ERRORS = 3;

/**
 * Poll vigil-approval-responses for an approval decision.
 *
 * Searches for a document matching both incident_id and action_id, sleeping
 * pollIntervalMs between each poll. Returns as soon as a decision is found
 * or the timeout expires.
 *
 * @param {string} incidentId - Incident identifier
 * @param {string} actionId - Action identifier (ACT-{year}-{slug})
 * @param {object} [options] - Configuration overrides
 * @param {number} [options.timeoutMinutes=15] - Minutes to poll before timing out
 * @param {number} [options.pollIntervalMs=15000] - Milliseconds between polls
 * @param {number} [options.maxPollErrors=3] - Consecutive errors before aborting
 * @returns {Promise<{ status: string, decided_by: string|null, decided_at: string|null }>}
 */
export async function pollForApproval(incidentId, actionId, options = {}) {
  const timeoutMinutes = options.timeoutMinutes ?? 15;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const maxPollErrors = options.maxPollErrors ?? DEFAULT_MAX_POLL_ERRORS;

  const timeoutMs = timeoutMinutes * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  log.info(`Polling for approval: incident=${incidentId} action=${actionId} timeout=${timeoutMinutes}m`);

  while (Date.now() < deadline) {
    let searchResult;
    try {
      searchResult = await client.search({
        index: 'vigil-approval-responses',
        query: {
          bool: {
            filter: [
              { term: { 'incident_id.keyword': incidentId } },
              { term: { 'action_id.keyword': actionId } }
            ]
          }
        },
        sort: [{ '@timestamp': 'desc' }],
        size: 1
      });
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      log.warn(
        `Poll failed for ${actionId} (${consecutiveErrors}/${maxPollErrors}): ${err.message}`
      );
      if (consecutiveErrors >= maxPollErrors) {
        throw new Error(
          `Approval polling failed ${maxPollErrors} consecutive times for action ${actionId}: ${err.message}`
        );
      }
      if (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      continue;
    }

    const hit = searchResult.hits?.hits?.[0]?._source;
    if (!hit) {
      if (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      continue;
    }

    if (hit.value === 'approve' || hit.value === 'approved') {
      log.info(`Approval granted for action ${actionId} by ${hit.user || 'unknown'}`);
      return {
        status: 'approved',
        decided_by: hit.user || null,
        decided_at: hit['@timestamp'] || null
      };
    }

    if (hit.value === 'reject' || hit.value === 'rejected') {
      log.info(`Approval rejected for action ${actionId} by ${hit.user || 'unknown'}`);
      return {
        status: 'rejected',
        decided_by: hit.user || null,
        decided_at: hit['@timestamp'] || null
      };
    }

    // more_info or unknown — continue polling
    if (hit.value === 'more_info' || hit.value === 'info') {
      log.info(`Approver requested more info for ${actionId}`);
    }

    // Sleep after the poll, not before
    if (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  log.warn(`Approval timed out for action ${actionId} after ${timeoutMinutes} minutes`);
  return { status: 'timeout', decided_by: null, decided_at: null };
}
