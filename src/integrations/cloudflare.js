// Cloudflare WAF Rulesets API integration — block/unblock IP addresses.

import { createLogger } from '../utils/logger.js';
import { httpRequest, withBreaker, IntegrationError } from './base-client.js';

const log = createLogger('integration-cloudflare');

const CF_BASE = 'https://api.cloudflare.com/client/v4';

const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

// ─── Internal helpers ─────────────────────────────────────────────────

function requireConfig() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ZONE_ID || !process.env.CLOUDFLARE_RULESET_ID) {
    throw new IntegrationError(
      'CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, and CLOUDFLARE_RULESET_ID must be configured',
      { integration: 'cloudflare', retryable: false }
    );
  }
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function buildExpression(ipOrCidr) {
  if (ipOrCidr.includes('/')) {
    return `ip.src in {${ipOrCidr}}`;
  }
  return `ip.src eq ${ipOrCidr}`;
}

// ─── Exported functions ───────────────────────────────────────────────

/**
 * Block an IP address or CIDR range via Cloudflare WAF ruleset.
 *
 * @param {string} ipOrCidr - IP address or CIDR
 * @param {string} incidentId - Vigil incident ID for tracking
 * @param {string} [description] - Optional rule description
 * @returns {Promise<{success: boolean, ruleId: string}>}
 */
export async function blockIP(ipOrCidr, incidentId, description) {
  requireConfig();
  if (!IP_OR_CIDR.test(ipOrCidr)) {
    throw new IntegrationError(`Invalid IP or CIDR: ${ipOrCidr}`, { integration: 'cloudflare', retryable: false });
  }
  log.info(`Blocking IP ${ipOrCidr} for incident ${incidentId}`);

  const ruleDescription = description || `Vigil auto-block: ${incidentId} — ${ipOrCidr}`;

  const response = await withBreaker('cloudflare', () =>
    httpRequest({
      method: 'POST',
      url: `${CF_BASE}/zones/${process.env.CLOUDFLARE_ZONE_ID}/rulesets/${process.env.CLOUDFLARE_RULESET_ID}/rules`,
      headers: authHeaders(),
      data: {
        action: 'block',
        expression: buildExpression(ipOrCidr),
        description: ruleDescription,
        enabled: true
      }
    })
  );

  const ruleId = response.data?.result?.id || response.data?.result?.rules?.slice(-1)[0]?.id;

  if (!ruleId) {
    throw new IntegrationError('Could not extract rule ID from Cloudflare response', {
      integration: 'cloudflare', retryable: false
    });
  }

  log.info(`Blocked ${ipOrCidr}: rule ${ruleId}`);
  return { success: true, ruleId };
}

/**
 * Remove a previously created block rule.
 *
 * @param {string} ruleId - Rule ID to remove
 * @returns {Promise<{success: boolean}>}
 */
export async function removeBlockRule(ruleId) {
  requireConfig();
  log.info(`Removing Cloudflare rule ${ruleId}`);

  await withBreaker('cloudflare', () =>
    httpRequest({
      method: 'DELETE',
      url: `${CF_BASE}/zones/${process.env.CLOUDFLARE_ZONE_ID}/rulesets/${process.env.CLOUDFLARE_RULESET_ID}/rules/${ruleId}`,
      headers: authHeaders()
    })
  );

  log.info(`Removed Cloudflare rule ${ruleId}`);
  return { success: true };
}
