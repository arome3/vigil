// Slack approval callback handler — pure business logic extracted from
// the original slack-handler.js. Takes parsed payload, returns result data.

import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('approval-handler');

/** Maps Slack button values to the canonical values approval-gate.js expects. */
const VALUE_NORMALIZE = Object.freeze({
  approved: 'approve',
  rejected: 'reject'
});

/**
 * Handle a Slack interactive approval callback.
 *
 * Extracts incident_id from action_id (strips vigil_approve_/vigil_reject_/vigil_info_ prefix),
 * normalizes the decision value, and indexes the response to vigil-approval-responses.
 *
 * @param {object} payload - Parsed Slack interaction payload
 * @returns {Promise<{incidentId: string, action: string, updatedBy: string}>}
 */
export async function handleApprovalCallback(payload) {
  const action = payload.actions?.[0];
  if (!action) {
    log.warn('No action found in Slack interaction payload');
    return { incidentId: null, action: null, updatedBy: null, indexed: false };
  }

  // Extract incident_id from action_id (strip vigil_approve_/vigil_reject_/vigil_info_ prefix)
  const incidentId = action.action_id.replace(/^vigil_(?:approve|reject|info)_/, '');
  if (!incidentId || !/^[A-Za-z0-9_-]+$/.test(incidentId)) {
    log.warn(`Invalid incident ID extracted: ${incidentId}`);
    return { incidentId: null, action: null, updatedBy: null, indexed: false };
  }

  // Extract action_id from pipe-delimited button value (e.g., "approved|ACT-2026-XXXXX")
  const valueParts = (action.value || '').split('|');
  const rawDecision = valueParts[0];
  const actionId = valueParts[1] || null;

  const userName = payload.user?.name || payload.user?.username || 'unknown';

  // "info" actions are handled at the webhook-server layer, not here
  if (rawDecision === 'info') {
    log.info(`Info request for ${incidentId} by ${userName}`);
    return { incidentId, action: 'info', updatedBy: userName, indexed: false };
  }

  const normalizedValue = VALUE_NORMALIZE[rawDecision] || rawDecision;

  try {
    await client.index({
      index: 'vigil-approval-responses',
      document: {
        '@timestamp': new Date().toISOString(),
        incident_id: incidentId,
        action_id: actionId,
        value: normalizedValue,
        user: userName,
        reason: rawDecision === 'rejected'
          ? `Rejected by ${userName}`
          : null
      }
    });
    log.info(`Indexed approval response: ${normalizedValue} for ${incidentId} action ${actionId} by ${userName}`);
  } catch (err) {
    log.error(`Failed to index approval response for ${incidentId}: ${err.message}`);
    return { incidentId, action: normalizedValue, updatedBy: userName, indexed: false };
  }

  return { incidentId, action: normalizedValue, updatedBy: userName, indexed: true };
}
