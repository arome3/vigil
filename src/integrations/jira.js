// Jira REST API v3 integration — incident ticket creation,
// status transitions, and commenting.

import { createLogger } from '../utils/logger.js';
import { httpRequest, withBreaker, IntegrationError } from './base-client.js';

const log = createLogger('integration-jira');

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'VIG';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Bug';

export const SEVERITY_TO_PRIORITY = Object.freeze({
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low'
});

// ─── Internal helpers ─────────────────────────────────────────────────

function buildAuthHeader() {
  if (JIRA_API_TOKEN && JIRA_USER_EMAIL) {
    const encoded = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  if (JIRA_API_TOKEN) {
    return { Authorization: `Bearer ${JIRA_API_TOKEN}` };
  }
  throw new IntegrationError('Jira credentials not configured', {
    integration: 'jira',
    retryable: false
  });
}

function requestHeaders() {
  return {
    ...buildAuthHeader(),
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

function apiUrl(path) {
  return `${JIRA_BASE_URL}/rest/api/3/${path}`;
}

/**
 * Build an Atlassian Document Format (ADF) description from summary and actions.
 */
function buildADFDescription(summary, actions) {
  const content = [
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Investigation Summary' }]
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: summary || 'No investigation summary available.' }]
    }
  ];

  if (actions && actions.length > 0) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Actions Taken' }]
    });
    content.push({
      type: 'bulletList',
      content: actions.map((a) => ({
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: typeof a === 'string' ? a : a.description || a.action_id || String(a) }] }
        ]
      }))
    });
  }

  return { type: 'doc', version: 1, content };
}

// ─── Exported functions ───────────────────────────────────────────────

/**
 * Create a Jira incident ticket.
 *
 * @param {object} incident - Incident data
 * @param {string} investigationSummary - Summary text
 * @param {Array} actionsTaken - List of actions
 * @returns {Promise<{key: string, id: string, self: string}>}
 */
export async function createIncidentTicket(incident, investigationSummary, actionsTaken) {
  log.info(`Creating Jira ticket for ${incident.incident_id}`);

  // Idempotency: check for existing ticket with same incident_id
  const searchResp = await withBreaker('jira', () =>
    httpRequest({
      method: 'GET',
      url: apiUrl(`search?jql=${encodeURIComponent(`project = ${JIRA_PROJECT_KEY} AND labels = "vigil" AND labels = "incident-${incident.incident_id}"`)}&maxResults=1`),
      headers: requestHeaders()
    })
  );
  if (searchResp.data.total > 0) {
    const existing = searchResp.data.issues[0];
    log.info(`Ticket ${existing.key} already exists for ${incident.incident_id}, skipping creation`);
    return { key: existing.key, id: existing.id, self: existing.self };
  }

  const priority = SEVERITY_TO_PRIORITY[incident.severity] || 'Medium';

  const response = await withBreaker('jira', () =>
    httpRequest({
      method: 'POST',
      url: apiUrl('issue'),
      headers: requestHeaders(),
      data: {
        fields: {
          project: { key: JIRA_PROJECT_KEY },
          summary: `[${incident.severity?.toUpperCase()}] ${incident.incident_id}: ${incident.type || 'Security Incident'}`,
          description: buildADFDescription(investigationSummary, actionsTaken),
          issuetype: { name: JIRA_ISSUE_TYPE },
          priority: { name: priority },
          labels: ['vigil', `severity-${incident.severity}`, 'auto-created', `incident-${incident.incident_id}`]
        }
      }
    })
  );

  const { key, id, self } = response.data;
  log.info(`Created Jira ticket ${key} for ${incident.incident_id}`);
  return { key, id, self };
}

/**
 * Transition a Jira ticket to a new status.
 *
 * @param {string} issueKey - e.g. "VIG-123"
 * @param {string} status - Target status name
 */
export async function updateTicketStatus(issueKey, status) {
  log.info(`Updating ${issueKey} status to ${status}`);

  // First, fetch available transitions to find the matching ID
  const transitionsResp = await withBreaker('jira', () =>
    httpRequest({
      method: 'GET',
      url: apiUrl(`issue/${issueKey}/transitions`),
      headers: requestHeaders()
    })
  );

  const transition = transitionsResp.data.transitions?.find(
    (t) => t.name.toLowerCase() === status.toLowerCase()
  );

  if (!transition) {
    throw new IntegrationError(
      `No transition found for status '${status}' on ${issueKey}`,
      { integration: 'jira', retryable: false }
    );
  }

  await withBreaker('jira', () =>
    httpRequest({
      method: 'POST',
      url: apiUrl(`issue/${issueKey}/transitions`),
      headers: requestHeaders(),
      data: { transition: { id: transition.id } }
    })
  );

  log.info(`Transitioned ${issueKey} to ${status}`);
}

/**
 * Add a comment to a Jira ticket.
 *
 * @param {string} issueKey
 * @param {string} commentText
 * @returns {Promise<{id: string}>}
 */
export async function addComment(issueKey, commentText) {
  if (!commentText || typeof commentText !== 'string') {
    throw new IntegrationError('commentText must be a non-empty string', { integration: 'jira', retryable: false });
  }
  log.info(`Adding comment to ${issueKey}`);

  const response = await withBreaker('jira', () =>
    httpRequest({
      method: 'POST',
      url: apiUrl(`issue/${issueKey}/comment`),
      headers: requestHeaders(),
      data: {
        body: {
          type: 'doc',
          version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: commentText }] }
          ]
        }
      }
    })
  );

  return { id: response.data.id };
}
