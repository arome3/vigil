// Slack Bot API integration — incident notifications, approval requests,
// resolution summaries, escalation alerts, and signature verification.

import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { httpRequest, withBreaker, IntegrationError } from './base-client.js';

const log = createLogger('integration-slack');

const INCIDENT_CHANNEL = process.env.SLACK_INCIDENT_CHANNEL || '#vigil-incidents';
const APPROVAL_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL || '#vigil-approvals';

const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

/** Maximum age of a Slack request timestamp before rejection (5 minutes). */
const MAX_TIMESTAMP_AGE_S = 300;

// ─── Internal helpers ─────────────────────────────────────────────────

function requireSlackToken() {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new IntegrationError('SLACK_BOT_TOKEN not configured', {
      integration: 'slack', retryable: false
    });
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' };
}

async function sendSlackMessage(channel, blocks, text) {
  requireSlackToken();
  log.info(`Sending Slack message to ${channel}`);
  const response = await withBreaker('slack', () =>
    httpRequest({
      method: 'POST',
      url: SLACK_POST_URL,
      headers: authHeaders(),
      data: { channel, blocks, text: text || '' }
    })
  );

  if (!response.data.ok) {
    const slackErr = response.data.error || 'unknown_error';
    const retryable = slackErr === 'rate_limited';
    const integrationErr = new IntegrationError(`Slack API error: ${slackErr}`, { integration: 'slack', retryable });
    if (retryable && response.headers?.['retry-after']) {
      integrationErr.retryAfter = Number(response.headers['retry-after']);
    }
    throw integrationErr;
  }

  return { ok: response.data.ok, ts: response.data.ts, channel: response.data.channel };
}

function severityEmoji(severity) {
  const map = { critical: ':red_circle:', high: ':large_orange_circle:', medium: ':large_yellow_circle:', low: ':white_circle:' };
  return map[severity] || ':grey_question:';
}

// ─── Block Kit builders ───────────────────────────────────────────────

function buildIncidentBlocks(incident) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${severityEmoji(incident.severity)} Incident: ${incident.incident_id}` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${incident.severity}` },
        { type: 'mrkdwn', text: `*Type:*\n${incident.type || 'unknown'}` },
        { type: 'mrkdwn', text: `*Service:*\n${incident.service || 'N/A'}` },
        { type: 'mrkdwn', text: `*Status:*\n${incident.status || 'new'}` }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:*\n${incident.investigation_summary || incident.description || 'No summary available'}` }
    }
  ];
}

function buildApprovalBlocks(incident, actions) {
  const actionBlocks = (actions || []).map((a, index) => ({
    type: 'button',
    text: { type: 'plain_text', text: `Approve: ${a.action_id || a.label || 'action'}` },
    action_id: `vigil_approve_${incident.incident_id}_${index}`,
    value: `approved|${a.action_id || ''}`,
    style: 'primary'
  }));

  const rejectButton = {
    type: 'button',
    text: { type: 'plain_text', text: 'Reject All' },
    action_id: `vigil_reject_${incident.incident_id}`,
    value: `rejected|${(actions || []).map(a => a.action_id || '').join(',')}`,
    style: 'danger'
  };

  const infoButton = {
    type: 'button',
    text: { type: 'plain_text', text: 'More Info' },
    action_id: `vigil_info_${incident.incident_id}`,
    value: `info|${incident.incident_id}`
  };

  return [
    ...buildIncidentBlocks(incident),
    {
      type: 'actions',
      elements: [...actionBlocks, rejectButton, infoButton]
    }
  ];
}

function buildResolutionBlocks(incident, metrics) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:white_check_mark: Resolved: ${incident.incident_id}` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${incident.severity}` },
        { type: 'mrkdwn', text: `*Resolution:*\n${incident.resolution || 'auto-resolved'}` }
      ]
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Timing:*\nDetection \u2192 Resolution: ${metrics.totalDurationMs ? `${Math.round(metrics.totalDurationMs / 1000)}s` : 'N/A'}\nPipeline stages: ${metrics.stageCount || 'N/A'}`
      }
    }
  ];
}

function buildEscalationBlocks(incident, reason, context) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:rotating_light: ESCALATION: ${incident.incident_id}` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${incident.severity}` },
        { type: 'mrkdwn', text: `*Reason:*\n${reason}` }
      ]
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reflection count:* ${context?.reflectionCount || 0}\n*Details:* ${context?.details || 'No additional context'}`
      }
    }
  ];
}

// ─── Exported functions ───────────────────────────────────────────────

export async function postIncidentNotification(incident) {
  const blocks = buildIncidentBlocks(incident);
  return sendSlackMessage(INCIDENT_CHANNEL, blocks, `Incident ${incident.incident_id}`);
}

export async function postApprovalRequest(incident, actions) {
  const blocks = buildApprovalBlocks(incident, actions);
  return sendSlackMessage(APPROVAL_CHANNEL, blocks, `Approval needed: ${incident.incident_id}`);
}

export async function postResolutionSummary(incident, metrics) {
  const blocks = buildResolutionBlocks(incident, metrics);
  return sendSlackMessage(INCIDENT_CHANNEL, blocks, `Resolved: ${incident.incident_id}`);
}

export async function postEscalationAlert(incident, reason, context) {
  const blocks = buildEscalationBlocks(incident, reason, context);
  return sendSlackMessage(INCIDENT_CHANNEL, blocks, `ESCALATION: ${incident.incident_id}`);
}

/**
 * Verify a Slack request signature using HMAC-SHA256.
 * Pure function — all inputs are explicit parameters.
 *
 * @param {string} signingSecret - Slack signing secret
 * @param {string} timestamp - x-slack-request-timestamp header value
 * @param {string} body - Raw request body
 * @param {string} signature - x-slack-signature header value
 * @returns {boolean}
 */
export function verifySlackSignature(signingSecret, timestamp, body, signature) {
  if (!signingSecret || !timestamp || !body || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_AGE_S) {
    log.warn(`Slack request timestamp too old: ${timestamp}`);
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}
