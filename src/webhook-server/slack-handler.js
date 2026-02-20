// Slack interaction handler — verifies request signatures and processes
// approval button callbacks from vigil-wf-approval interactive messages.

import crypto from 'crypto';
import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('slack-handler');

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

/** Maximum age of a Slack request timestamp before rejection (5 minutes). */
const MAX_TIMESTAMP_AGE_S = 300;

/** Maps Slack button values to the canonical values approval-gate.js expects. */
const VALUE_NORMALIZE = Object.freeze({
  approved: 'approve',
  rejected: 'reject'
});

/**
 * Verify a Slack request signature using HMAC-SHA256.
 *
 * Computes `v0:${timestamp}:${rawBody}` with the signing secret and compares
 * against the `x-slack-signature` header. Uses constant-time comparison to
 * prevent timing attacks. Rejects timestamps older than 5 minutes.
 *
 * @param {object} req - Express-like request with headers and rawBody
 * @param {string} req.rawBody - Raw request body as string
 * @returns {boolean} true if the signature is valid
 */
export function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) {
    log.error('SLACK_SIGNING_SECRET is not configured');
    return false;
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSignature = req.headers['x-slack-signature'];

  if (!timestamp || !slackSignature) {
    log.warn('Missing Slack signature headers');
    return false;
  }

  // Reject timestamps older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_AGE_S) {
    log.warn(`Slack request timestamp too old: ${timestamp} (now: ${now})`);
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(sigBasestring, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(slackSignature, 'utf8')
    );
  } catch {
    // timingSafeEqual throws if buffers differ in length
    return false;
  }
}

/**
 * Handle a Slack interactive approval callback.
 *
 * Parses the interaction payload, extracts incident_id from the action_id
 * (strips vigil_approve_/vigil_reject_/vigil_info_ prefix), extracts
 * action_id from the pipe-delimited button value, normalizes the decision
 * value, and indexes the response to vigil-approval-responses.
 *
 * For "info" buttons: fetches incident details and responds with an
 * ephemeral summary. Does NOT index to approval-responses.
 *
 * Always responds 200 to Slack to prevent retry loops, even on errors.
 *
 * @param {object} req - Express-like request
 * @param {object} res - Express-like response
 */
export async function handleApprovalCallback(req, res) {
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (err) {
    log.error(`Failed to parse Slack payload: ${err.message}`);
    res.status(200).json({ ok: false, error: 'Invalid payload' });
    return;
  }

  const action = payload.actions?.[0];
  if (!action) {
    log.warn('No action found in Slack interaction payload');
    res.status(200).json({ ok: false, error: 'No action' });
    return;
  }

  // Extract incident_id from action_id (strip vigil_approve_/vigil_reject_/vigil_info_ prefix)
  const incidentId = action.action_id.replace(/^vigil_(?:approve|reject|info)_/, '');

  // Extract action_id from pipe-delimited button value (e.g., "approved|ACT-2026-XXXXX")
  const valueParts = (action.value || '').split('|');
  const rawDecision = valueParts[0];
  const actionId = valueParts[1] || null;

  const userName = payload.user?.name || payload.user?.username || 'unknown';

  // --- "More Info" button: respond with ephemeral incident summary ---
  if (rawDecision === 'info') {
    try {
      const searchResult = await client.search({
        index: 'vigil-incidents',
        query: { term: { incident_id: incidentId } },
        size: 1
      });

      const incident = searchResult.hits?.hits?.[0]?._source;
      if (incident) {
        res.status(200).json({
          response_type: 'ephemeral',
          text: `*Investigation Summary:* ${incident.investigation_summary || 'N/A'}\n` +
                `*Affected Assets:* ${(incident.affected_assets || []).map(a => a.name || a).join(', ') || 'N/A'}\n` +
                `*Severity:* ${incident.severity || 'N/A'}\n` +
                `*Status:* ${incident.status || 'N/A'}`
        });
      } else {
        res.status(200).json({
          response_type: 'ephemeral',
          text: `No incident found for ${incidentId}`
        });
      }
    } catch (err) {
      log.error(`Failed to fetch incident ${incidentId}: ${err.message}`);
      res.status(200).json({
        response_type: 'ephemeral',
        text: `Error fetching incident details: ${err.message}`
      });
    }
    return;
  }

  // --- Approve / Reject: normalize value and index to approval-responses ---
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
    // Still respond 200 to Slack — prevent retry loops
  }

  // --- Update the original Slack message: replace buttons with result text ---
  try {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (slackToken && payload.channel?.id && payload.message?.ts) {
      const { WebClient } = await import('@slack/web-api');
      const slack = new WebClient(slackToken);

      const resultEmoji = normalizedValue === 'approve' ? ':white_check_mark:' : ':x:';
      const resultText = normalizedValue === 'approve'
        ? `*APPROVED* by @${userName} for ${incidentId}`
        : `*REJECTED* by @${userName} for ${incidentId}`;

      await slack.chat.update({
        channel: payload.channel.id,
        ts: payload.message.ts,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${resultEmoji} ${resultText}`
            }
          }
        ]
      });
    }
  } catch (err) {
    log.error(`Failed to update Slack message for ${incidentId}: ${err.message}`);
    // Non-fatal — the approval response was already indexed
  }

  res.status(200).json({ ok: true });
}
