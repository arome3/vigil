// Workflow secrets validator — checks that all required environment
// variables for Elastic Workflows are present before deployment.

import { createLogger } from '../utils/logger.js';

const log = createLogger('secrets-manager');

/**
 * Required secrets for all 6 Elastic Workflows.
 * Each entry maps an environment variable to its workflow secret name
 * and the workflows that consume it.
 */
const REQUIRED_SECRETS = Object.freeze([
  { envVar: 'SLACK_BOT_TOKEN',           secretName: 'slack_bot_token',           usedBy: 'notify, approval' },
  { envVar: 'SLACK_WEBHOOK_URL',          secretName: 'slack_webhook',             usedBy: 'containment (failure notify)' },
  { envVar: 'SLACK_INCIDENT_CHANNEL',     secretName: 'slack_incident_channel',    usedBy: 'notify' },
  { envVar: 'SLACK_APPROVAL_CHANNEL',     secretName: 'slack_approval_channel',    usedBy: 'approval' },
  { envVar: 'JIRA_BASE_URL',             secretName: 'jira_base_url',             usedBy: 'ticketing' },
  { envVar: 'JIRA_AUTH',                  secretName: 'jira_auth',                 usedBy: 'ticketing' },
  { envVar: 'JIRA_PROJECT_KEY',          secretName: 'jira_project_key',          usedBy: 'ticketing' },
  { envVar: 'PAGERDUTY_ROUTING_KEY',     secretName: 'pagerduty_routing_key',     usedBy: 'notify (critical only)' },
  { envVar: 'CLOUDFLARE_API_TOKEN',      secretName: 'cloudflare_token',          usedBy: 'containment' },
  { envVar: 'CLOUDFLARE_ZONE_ID',        secretName: 'cloudflare_zone_id',        usedBy: 'containment' },
  { envVar: 'CLOUDFLARE_RULESET_ID',     secretName: 'cloudflare_ruleset_id',     usedBy: 'containment' },
  { envVar: 'OKTA_OAUTH_TOKEN',          secretName: 'okta_oauth_token',          usedBy: 'containment' },
  { envVar: 'K8S_SERVICE_ACCOUNT_TOKEN', secretName: 'kubernetes_token',          usedBy: 'remediation' },
  { envVar: 'K8S_API_URL',              secretName: 'kubernetes_api_url',         usedBy: 'remediation' },
  { envVar: 'KIBANA_URL',               secretName: 'kibana_url',                usedBy: 'notify (deep links)' },
  { envVar: 'SLACK_SIGNING_SECRET',    secretName: 'slack_signing_secret',      usedBy: 'webhook-server (signature verification)' },
  { envVar: 'EMAIL_API_URL',           secretName: 'email_api_url',             usedBy: 'notify (email)' },
  { envVar: 'EMAIL_API_KEY',           secretName: 'email_api_key',             usedBy: 'notify (email)' }
]);

/**
 * Validate that all required workflow secrets are present in the environment.
 * Empty string values are treated as missing. Never throws — always returns
 * a result object.
 *
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateWorkflowSecrets() {
  const missing = [];

  for (const secret of REQUIRED_SECRETS) {
    const value = process.env[secret.envVar];
    if (!value || value.trim() === '') {
      missing.push(secret.envVar);
      log.warn(`Missing secret: ${secret.envVar} (${secret.secretName}) — used by: ${secret.usedBy}`);
    }
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Get the full list of required secrets with metadata.
 *
 * @returns {Array<{ envVar: string, secretName: string, usedBy: string }>}
 */
export function getRequiredSecrets() {
  return REQUIRED_SECRETS;
}
