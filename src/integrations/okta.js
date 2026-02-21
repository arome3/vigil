// Okta User Lifecycle API integration — suspend, unsuspend, and lookup users.

import { createLogger } from '../utils/logger.js';
import { httpRequest, withBreaker, IntegrationError } from './base-client.js';

const log = createLogger('integration-okta');

// ─── Internal helpers ─────────────────────────────────────────────────

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.OKTA_OAUTH_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

function apiUrl(path) {
  return `https://${process.env.OKTA_DOMAIN}/api/v1/${path}`;
}

// ─── Validation ───────────────────────────────────────────────────────

function requireConfig() {
  if (!process.env.OKTA_DOMAIN || !process.env.OKTA_OAUTH_TOKEN) {
    throw new IntegrationError('OKTA_DOMAIN and OKTA_OAUTH_TOKEN must be configured', {
      integration: 'okta', retryable: false
    });
  }
}

// ─── Exported functions ───────────────────────────────────────────────

/**
 * Suspend an Okta user (prevents login without deleting account).
 *
 * @param {string} userId - Okta user ID
 * @returns {Promise<{success: boolean}>}
 */
export async function suspendUser(userId) {
  requireConfig();
  log.info(`Suspending Okta user ${userId}`);

  await withBreaker('okta', () =>
    httpRequest({
      method: 'POST',
      url: apiUrl(`users/${userId}/lifecycle/suspend`),
      headers: authHeaders()
    })
  );

  log.info(`Okta user ${userId} suspended`);
  return { success: true };
}

/**
 * Unsuspend a previously suspended Okta user.
 *
 * @param {string} userId - Okta user ID
 * @returns {Promise<{success: boolean}>}
 */
export async function unsuspendUser(userId) {
  requireConfig();
  log.info(`Unsuspending Okta user ${userId}`);

  await withBreaker('okta', () =>
    httpRequest({
      method: 'POST',
      url: apiUrl(`users/${userId}/lifecycle/unsuspend`),
      headers: authHeaders()
    })
  );

  log.info(`Okta user ${userId} unsuspended`);
  return { success: true };
}

/**
 * Look up an Okta user by login (email).
 *
 * @param {string} login - User login/email
 * @returns {Promise<{id: string, status: string, profile: object}>}
 */
export async function lookupUserByLogin(login) {
  requireConfig();
  log.info(`Looking up Okta user by login: ${login}`);

  const response = await withBreaker('okta', () =>
    httpRequest({
      method: 'GET',
      url: apiUrl(`users/${encodeURIComponent(login)}`),
      headers: authHeaders()
    })
  );

  const { id, status, profile } = response.data;
  return { id, status, profile };
}
