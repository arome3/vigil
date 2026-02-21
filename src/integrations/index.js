// Barrel export for all external integrations.

// Base client
export { IntegrationError, httpRequest, withRetry, withBreaker, sleep } from './base-client.js';

// Circuit breaker
export { getBreaker, resetBreaker } from './circuit-breaker.js';

// Slack
export {
  postIncidentNotification,
  postApprovalRequest,
  postResolutionSummary,
  postEscalationAlert,
  verifySlackSignature
} from './slack.js';

// Jira
export {
  createIncidentTicket,
  updateTicketStatus,
  addComment,
  SEVERITY_TO_PRIORITY
} from './jira.js';

// PagerDuty (aliased to avoid naming collisions)
export {
  triggerIncident as triggerPagerDuty,
  resolveIncident as resolvePagerDuty,
  SEVERITY_MAP as PAGERDUTY_SEVERITY_MAP
} from './pagerduty.js';

// Kubernetes
export {
  restartDeployment,
  rollbackDeployment,
  scaleDeployment,
  getDeploymentStatus
} from './kubernetes.js';

// Cloudflare
export { blockIP, removeBlockRule } from './cloudflare.js';

// Okta
export { suspendUser, unsuspendUser, lookupUserByLogin } from './okta.js';
