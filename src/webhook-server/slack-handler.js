// Re-export shim — preserves backward compatibility for code importing
// from the old slack-handler path. Verification logic moved to
// integrations/slack.js, approval logic moved to approval-handler.js.

export { verifySlackSignature } from '../integrations/slack.js';
export { handleApprovalCallback } from './approval-handler.js';
