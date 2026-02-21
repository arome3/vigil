// GitHub webhook receiver — signature verification and event indexing.

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('github-webhook');

/**
 * Verify a GitHub webhook signature using HMAC-SHA256.
 * Pure function — all inputs are explicit parameters.
 *
 * @param {string} secret - GitHub webhook secret
 * @param {string} payload - Raw request body
 * @param {string} signature - x-hub-signature-256 header value (sha256=...)
 * @returns {boolean}
 */
export function verifyGitHubSignature(secret, payload, signature) {
  if (!secret || !payload || !signature) return false;

  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(sig, 'utf8')
    );
  } catch {
    return false;
  }
}

// ─── Event transformers ───────────────────────────────────────────────

function transformPushEvent(payload) {
  return {
    event_type: 'push',
    repository: payload.repository?.full_name,
    branch: payload.ref?.replace('refs/heads/', ''),
    commit_count: payload.commits?.length || 0,
    head_commit: payload.head_commit?.id,
    head_commit_message: payload.head_commit?.message,
    pusher: payload.pusher?.name
  };
}

function transformDeploymentEvent(event, payload) {
  return {
    event_type: event,
    repository: payload.repository?.full_name,
    environment: payload.deployment?.environment,
    sha: payload.deployment?.sha,
    creator: payload.deployment?.creator?.login,
    status: payload.deployment_status?.state,
    description: payload.deployment_status?.description
  };
}

function transformPullRequestEvent(payload) {
  if (payload.action !== 'closed' || !payload.pull_request?.merged) return null;

  return {
    event_type: 'pull_request_merged',
    repository: payload.repository?.full_name,
    pr_number: payload.pull_request?.number,
    title: payload.pull_request?.title,
    merged_by: payload.pull_request?.merged_by?.login,
    base_branch: payload.pull_request?.base?.ref,
    head_branch: payload.pull_request?.head?.ref,
    additions: payload.pull_request?.additions,
    deletions: payload.pull_request?.deletions,
    changed_files: payload.pull_request?.changed_files
  };
}

const EVENT_TRANSFORMERS = {
  push: (_event, payload) => transformPushEvent(payload),
  deployment: (event, payload) => transformDeploymentEvent(event, payload),
  deployment_status: (event, payload) => transformDeploymentEvent(event, payload),
  pull_request: (_event, payload) => transformPullRequestEvent(payload)
};

// ─── Exported functions ───────────────────────────────────────────────

/**
 * Handle a GitHub webhook event — transform and index to Elasticsearch.
 *
 * @param {string} event - GitHub event type (x-github-event header)
 * @param {object} payload - Parsed event payload
 * @returns {Promise<{indexed: boolean, eventId: string}>}
 */
export async function handleGitHubWebhook(event, payload) {
  const transformer = EVENT_TRANSFORMERS[event];
  if (!transformer) {
    log.info(`Ignoring unhandled GitHub event: ${event}`);
    return { indexed: false, eventId: null };
  }

  const document = transformer(event, payload);
  if (!document) {
    log.info(`Skipping filtered GitHub event: ${event}`);
    return { indexed: false, eventId: null };
  }

  const eventId = uuidv4();
  document['@timestamp'] = new Date().toISOString();
  document.event_id = eventId;

  try {
    await client.index({
      index: 'vigil-github-events',
      id: eventId,
      document
    });
    log.info(`Indexed GitHub ${event} event: ${eventId}`);
    return { indexed: true, eventId };
  } catch (err) {
    log.error(`Failed to index GitHub ${event} event: ${err.message}`);
    return { indexed: false, eventId, error: err.message };
  }
}
