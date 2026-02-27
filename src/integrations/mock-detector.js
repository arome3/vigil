// Check which integrations are available vs need mocking.
//
// Used by workflow execution to decide between real and mock calls.
// When integration env vars are missing, workflows operate in mock mode —
// logging what they would have done without actually calling external APIs.

/**
 * Returns the availability status of each integration.
 *
 * @returns {Object} Keys: slack, jira, pagerduty, cloudflare, okta, kubernetes.
 *   Each value: { available: boolean, mock: boolean }
 */
export function getIntegrationStatus() {
  return {
    slack: {
      available: !!process.env.SLACK_BOT_TOKEN,
      mock: !process.env.SLACK_BOT_TOKEN
    },
    jira: {
      available: !!process.env.JIRA_API_TOKEN,
      mock: !process.env.JIRA_API_TOKEN
    },
    pagerduty: {
      available: !!process.env.PAGERDUTY_ROUTING_KEY,
      mock: !process.env.PAGERDUTY_ROUTING_KEY
    },
    cloudflare: {
      available: !!process.env.CLOUDFLARE_API_TOKEN,
      mock: !process.env.CLOUDFLARE_API_TOKEN
    },
    okta: {
      available: !!process.env.OKTA_OAUTH_TOKEN,
      mock: !process.env.OKTA_OAUTH_TOKEN
    },
    kubernetes: {
      available: !!process.env.K8S_CONTEXT,
      mock: !process.env.K8S_CONTEXT
    }
  };
}
