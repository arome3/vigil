// Executor approval gate — sends interactive approval requests via
// vigil-wf-approval and polls vigil-approval-responses for decisions.

import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';

const log = createLogger('executor-approval');

/** Severity derived from action type — unknown types fall back to 'high'. */
const ACTION_TYPE_SEVERITY = Object.freeze({
  containment:   'critical',
  remediation:   'high',
  communication: 'low',
  documentation: 'low'
});

// Defaults — callers can override via options parameter for testing.
const DEFAULT_TIMEOUT_MINUTES =
  parseInt(process.env.VIGIL_APPROVAL_TIMEOUT_MINUTES || '15', 10);
const DEFAULT_POLL_INTERVAL_MS =
  parseInt(process.env.VIGIL_APPROVAL_POLL_INTERVAL_MS || '15000', 10);

/** Maximum consecutive polling failures before giving up. */
const MAX_POLL_ERRORS = 3;

/**
 * Run the approval gate for a single action.
 *
 * 1. Sends an approval request to vigil-wf-approval (interactive Slack message).
 * 2. Polls vigil-approval-responses for a matching decision document.
 * 3. Returns the outcome: approved, rejected, or timeout.
 *
 * @param {string} incidentId
 * @param {object} action - The action requiring approval
 * @param {string} actionId - Generated ACT-{year}-{slug} identifier
 * @param {object} [options] - Optional overrides (primarily for testing)
 * @param {number} [options.timeoutMinutes] - Override approval timeout
 * @param {number} [options.pollIntervalMs] - Override poll interval
 * @returns {Promise<{ status: string, decided_by: string|null, decided_at: string|null }>}
 */
export async function checkApprovalGate(incidentId, action, actionId, options = {}) {
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // --- Send approval request ---
  const approvalEnvelope = createEnvelope('vigil-executor', 'vigil-wf-approval', incidentId, {
    task: 'request_approval',
    incident_id: incidentId,
    action_id: actionId,
    action_summary: action.description,
    action_type: action.action_type,
    target_system: action.target_system,
    target_asset: action.target_asset || null,
    severity: ACTION_TYPE_SEVERITY[action.action_type] ?? 'high'
  });

  try {
    await sendA2AMessage('vigil-wf-approval', approvalEnvelope, { timeout: 30_000 });
  } catch (err) {
    throw new Error(
      `Failed to dispatch approval request for action ${actionId}: ${err.message}`
    );
  }

  log.info(`Approval requested for action ${actionId} in incident ${incidentId}`);

  // --- Poll for decision ---
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    let searchResult;
    try {
      searchResult = await client.search({
        index: 'vigil-approval-responses',
        query: {
          bool: {
            filter: [
              { term: { incident_id: incidentId } },
              { term: { action_id: actionId } }
            ]
          }
        },
        sort: [{ '@timestamp': 'desc' }],
        size: 1
      });
      // Reset error counter on successful poll
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      log.warn(
        `Approval poll failed for ${actionId} (${consecutiveErrors}/${MAX_POLL_ERRORS}): ${err.message}`
      );
      if (consecutiveErrors >= MAX_POLL_ERRORS) {
        throw new Error(
          `Approval polling failed ${MAX_POLL_ERRORS} consecutive times for action ${actionId}: ${err.message}`
        );
      }
      // Transient error — sleep and retry on next poll interval
      if (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      continue;
    }

    const hit = searchResult.hits?.hits?.[0]?._source;
    if (!hit) {
      // No decision yet — sleep and continue polling
      if (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      continue;
    }

    if (hit.value === 'approve' || hit.value === 'approved') {
      log.info(`Approval granted for action ${actionId} by ${hit.user || 'unknown'}`);
      return { status: 'approved', decided_by: hit.user || 'unknown', decided_at: hit['@timestamp'] || null };
    }

    if (hit.value === 'reject' || hit.value === 'rejected') {
      log.info(`Approval rejected for action ${actionId} by ${hit.user || 'unknown'}`);
      return { status: 'rejected', decided_by: hit.user || 'unknown', decided_at: hit['@timestamp'] || null };
    }

    if (hit.value === 'more_info' || hit.value === 'info') {
      // The approver wants additional context before deciding. The Executor
      // does not currently have a mechanism to push context back into the Slack
      // thread — this would require a dedicated "approval-context" workflow.
      // For now, we log the request and continue polling. The total approval
      // window remains fixed (no deadline extension) to prevent indefinite waits.
      log.info(`Approver requested more info for ${actionId} in incident ${incidentId}`);
    }

    // Sleep after the poll, not before
    if (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  // Timeout
  log.warn(`Approval timed out for action ${actionId} after ${timeoutMinutes} minutes`);
  return { status: 'timeout', decided_by: null, decided_at: null };
}
