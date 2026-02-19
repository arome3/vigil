// Executor workflow router — maps action types to Elastic Workflow IDs.
// Pure functions, no async, no ES client.

export const VALID_ACTION_TYPES = ['containment', 'remediation', 'communication', 'documentation'];

const ROUTING_TABLE = Object.freeze({
  containment:   'vigil-wf-containment',
  remediation:   'vigil-wf-remediation',
  communication: 'vigil-wf-notify',
  documentation: 'vigil-wf-ticketing'
});

/**
 * Route an action to the appropriate Elastic Workflow.
 *
 * @param {object} action - A single action from the remediation plan
 * @returns {{ workflowId: string, workflowParams: object }}
 * @throws {Error} If action.action_type is not a valid type
 */
export function routeAction(action) {
  const workflowId = ROUTING_TABLE[action.action_type];

  if (!workflowId) {
    throw new Error(
      `Unknown action_type: '${action.action_type}'. ` +
      `Valid types: ${VALID_ACTION_TYPES.join(', ')}`
    );
  }

  return {
    workflowId,
    workflowParams: {
      action_type: action.action_type,
      description: action.description,
      target_system: action.target_system,
      target_asset: action.target_asset || null,
      params: action.params || {},
      rollback_steps: action.rollback_steps || null
    }
  };
}
