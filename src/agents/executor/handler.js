// Executor Agent A2A request handler.
// Receives execute_plan requests from vigil-coordinator, executes each action
// sequentially through Elastic Workflows, enforces approval gates, and produces
// audit records for every action attempted.

import { v4 as uuidv4 } from 'uuid';
import { validateExecuteResponse } from '../../a2a/contracts.js';
import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';
import { routeAction, VALID_ACTION_TYPES } from './workflow-router.js';
import { checkApprovalGate } from './approval-gate.js';
import { logAuditRecord } from './audit-logger.js';
import { ExecutionDeadlineError } from './errors.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('executor-handler');

// --- Configuration ---

/** Default deadline — callers can override via options.deadlineMs for testing. */
const DEFAULT_DEADLINE_MS =
  parseInt(process.env.VIGIL_EXECUTOR_DEADLINE_MS, 10) || 280_000;

const WORKFLOW_TIMEOUT_MS =
  parseInt(process.env.VIGIL_WORKFLOW_TIMEOUT_MS, 10) || 120_000;

const APPROVAL_TIMEOUT_MINUTES =
  parseInt(process.env.VIGIL_APPROVAL_TIMEOUT_MINUTES || '15', 10);

// --- Helpers ---

/**
 * Fire-and-forget audit write. Catches synchronous and async errors so that
 * a failing audit logger never halts the execution pipeline.
 * Not awaited — the handler proceeds immediately to the next action.
 * @param {object} record
 */
function safeAuditLog(record) {
  try {
    const result = logAuditRecord(record);
    // Catch async rejection from the returned promise (fire-and-forget)
    if (result && typeof result.catch === 'function') {
      result.catch(err => {
        log.error(`Audit log async error for ${record.action_id}: ${err.message}`);
      });
    }
  } catch (err) {
    log.error(`Audit log call threw synchronously for ${record.action_id}: ${err.message}`);
  }
}

/**
 * Generate a unique action ID in the project convention format.
 * @returns {string} e.g. "ACT-2026-A1B2C"
 */
function generateActionId() {
  const year = new Date().getFullYear();
  const slug = uuidv4().slice(0, 5).toUpperCase();
  return `ACT-${year}-${slug}`;
}

/**
 * Build a complete audit record from action context.
 * Centralises the record shape so all three audit call-sites (approval-rejected,
 * approval-timeout, normal execution) produce identical schemas.
 *
 * @param {object} p
 * @returns {object} Audit record ready for logAuditRecord()
 */
function buildAuditRecord({
  actionId, incidentId, action, actionStartedAt,
  executionStatus, errorMessage, resultSummary,
  approvedBy, approvedAt, workflowId
}) {
  const completedAt = new Date().toISOString();
  const rollbackAvailable = action.rollback_steps != null
    && action.rollback_steps !== 'N/A'
    && action.rollback_steps !== '';

  return {
    action_id: actionId,
    incident_id: incidentId,
    action_type: action.action_type,
    action_detail: action.description,
    target_system: action.target_system,
    target_asset: action.target_asset || null,
    approval_required: action.approval_required,
    approved_by: approvedBy || null,
    approved_at: approvedAt || null,
    execution_status: executionStatus,
    started_at: actionStartedAt,
    completed_at: completedAt,
    duration_ms: new Date(completedAt) - new Date(actionStartedAt),
    result_summary: resultSummary || null,
    rollback_available: rollbackAvailable,
    error_message: errorMessage,
    workflow_id: workflowId || null
  };
}

/**
 * Build the action_results entry returned to the Coordinator.
 */
function buildActionResult(action, actionId, executionStatus, errorMessage) {
  return {
    order: action.order,
    action_id: actionId,
    execution_status: executionStatus,
    error_message: errorMessage
  };
}

/**
 * Validate required fields on a single action object.
 * @param {object} action
 * @param {number} index
 * @returns {string|null} Error message, or null if valid
 */
function validateAction(action, index) {
  const order = index + 1;
  if (typeof action.order !== 'number') {
    return `Action at order ${order} missing required field: order`;
  }
  if (typeof action.action_type !== 'string' || !action.action_type) {
    return `Action at order ${action.order ?? order} missing required field: action_type`;
  }
  if (typeof action.description !== 'string' || !action.description) {
    return `Action at order ${action.order ?? order} missing required field: description`;
  }
  if (typeof action.target_system !== 'string' || !action.target_system) {
    return `Action at order ${action.order ?? order} missing required field: target_system`;
  }
  if (typeof action.approval_required !== 'boolean') {
    return `Action at order ${action.order ?? order} missing required field: approval_required`;
  }
  return null;
}

/**
 * Compute the final status from execution counters.
 *
 * @param {number} actionsCompleted
 * @param {number} actionsFailed
 * @param {Array} actionResults
 * @returns {'completed'|'partial_failure'|'failed'}
 */
function computeStatus(actionsCompleted, actionsFailed, actionResults) {
  const hasSkipped = actionResults.some(r => r.execution_status === 'skipped');

  if (actionsFailed === 0 && !hasSkipped) return 'completed';
  if (actionsCompleted > 0) return 'partial_failure';
  return 'failed';
}

/**
 * Idempotency guard — checks whether this incident already has audit records
 * in vigil-actions. Returns true if prior execution exists.
 * On ES failure, logs a warning and returns false (allows execution to proceed).
 */
async function checkAlreadyExecuted(incidentId) {
  try {
    const result = await client.search({
      index: 'vigil-actions',
      query: { term: { incident_id: incidentId } },
      size: 1
    });
    return result.hits.hits.length > 0;
  } catch (err) {
    log.warn(`Idempotency check failed for ${incidentId}, proceeding with execution: ${err.message}`);
    return false;
  }
}

// --- Request Handler ---

/**
 * A2A request handler for the Executor agent.
 * Validates the incoming request, races the execution loop against a deadline,
 * and returns a validated execution response.
 *
 * @param {object} envelope - Request from vigil-coordinator via buildExecuteRequest()
 * @param {object} [options] - Optional overrides (primarily for testing)
 * @param {number} [options.deadlineMs] - Override the execution deadline
 * @returns {Promise<object>} Validated execute response matching Contract 5 (§8.5)
 */
export async function handleExecutePlan(envelope, options = {}) {
  // --- Request validation ---

  if (envelope.task !== 'execute_plan') {
    throw new Error(
      `Executor received unknown task: '${envelope.task}' (expected 'execute_plan')`
    );
  }

  if (!envelope.incident_id) {
    throw new Error('Executor request missing required field: incident_id');
  }

  if (!envelope.remediation_plan || typeof envelope.remediation_plan !== 'object') {
    throw new Error('Executor request missing required field: remediation_plan');
  }

  const actions = envelope.remediation_plan.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('Executor request requires a non-empty actions array');
  }

  // Validate each action's required fields
  for (let i = 0; i < actions.length; i++) {
    const fieldError = validateAction(actions[i], i);
    if (fieldError) {
      throw new Error(fieldError);
    }
  }

  // Check for unknown action_types — return structured failure, don't throw
  for (const action of actions) {
    if (!VALID_ACTION_TYPES.includes(action.action_type)) {
      const response = {
        incident_id: envelope.incident_id,
        status: 'failed',
        actions_completed: 0,
        actions_failed: 1,
        action_results: [{
          order: action.order,
          action_id: generateActionId(),
          execution_status: 'failed',
          error_message:
            `Unknown action_type: '${action.action_type}'. ` +
            `Valid types: ${VALID_ACTION_TYPES.join(', ')}`
        }]
      };
      validateExecuteResponse(response);
      return response;
    }
  }

  // Sort actions by order ascending, de-duplicate by order value
  const sortedActions = [...actions]
    .sort((a, b) => a.order - b.order)
    .filter((action, idx, arr) => idx === 0 || action.order !== arr[idx - 1].order);

  if (sortedActions.length < actions.length) {
    log.warn(`Deduplicated ${actions.length - sortedActions.length} actions with duplicate order values`, {
      incident_id: envelope.incident_id
    });
  }

  // --- Idempotency guard ---
  const alreadyExecuted = await checkAlreadyExecuted(envelope.incident_id);
  if (alreadyExecuted) {
    log.warn(`Incident ${envelope.incident_id} already has execution records, skipping re-execution`);
    const response = {
      incident_id: envelope.incident_id,
      status: 'completed',
      actions_completed: 0,
      actions_failed: 0,
      action_results: []
    };
    validateExecuteResponse(response);
    return response;
  }

  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startTime = Date.now();
  log.info(`Executing plan for incident ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    action_count: sortedActions.length,
    deadline_ms: deadlineMs
  });

  // --- Deadline-wrapped execution ---

  const actionResults = [];
  let actionsCompleted = 0;
  let actionsFailed = 0;
  let deadlineHandle;

  try {
    const deadline = new Promise((_, reject) => {
      deadlineHandle = setTimeout(
        () => reject(new ExecutionDeadlineError(envelope.incident_id, Date.now() - startTime)),
        deadlineMs
      );
    });

    const executionLoop = async () => {
      for (const action of sortedActions) {
        const actionId = generateActionId();
        const actionStartedAt = new Date().toISOString();
        let executionStatus = 'completed';
        let errorMessage = null;
        let resultSummary = null;
        let approvedBy = null;
        let approvedAt = null;
        let workflowId = null;

        try {
          // --- Approval gate (if required) ---
          if (action.approval_required === true) {
            const approval = await checkApprovalGate(
              envelope.incident_id, action, actionId
            );

            if (approval.status !== 'approved') {
              // Rejected or timed out — log, record, and halt
              executionStatus = 'skipped';
              approvedBy = approval.decided_by;
              approvedAt = approval.decided_at;

              errorMessage = approval.status === 'rejected'
                ? `Approval rejected by ${approval.decided_by}`
                : `Approval timed out after ${APPROVAL_TIMEOUT_MINUTES} minutes`;

              safeAuditLog(buildAuditRecord({
                actionId, incidentId: envelope.incident_id, action, actionStartedAt,
                executionStatus, errorMessage, resultSummary: null,
                approvedBy, approvedAt, workflowId: null
              }));
              actionResults.push(buildActionResult(action, actionId, executionStatus, errorMessage));
              break;
            }

            // Approved
            approvedBy = approval.decided_by;
            approvedAt = approval.decided_at;
          }

          // --- Route and execute ---
          const route = routeAction(action);
          workflowId = route.workflowId;

          const workflowEnvelope = createEnvelope(
            'vigil-executor', workflowId, envelope.incident_id, {
              task: action.action_type,
              incident_id: envelope.incident_id,
              action_id: actionId,
              ...route.workflowParams
            }
          );

          const workflowResult = await sendA2AMessage(workflowId, workflowEnvelope, {
            timeout: WORKFLOW_TIMEOUT_MS
          });

          resultSummary = workflowResult?.result_summary || `${action.description} completed`;
          actionsCompleted++;
        } catch (err) {
          executionStatus = 'failed';
          errorMessage = err.message;
          actionsFailed++;
        }

        // --- Audit (ALWAYS, even on failure) ---
        safeAuditLog(buildAuditRecord({
          actionId, incidentId: envelope.incident_id, action, actionStartedAt,
          executionStatus, errorMessage, resultSummary,
          approvedBy, approvedAt, workflowId
        }));
        actionResults.push(buildActionResult(action, actionId, executionStatus, errorMessage));

        // Stop on failure
        if (executionStatus === 'failed') {
          break;
        }
      }
    };

    await Promise.race([executionLoop(), deadline]);
  } catch (err) {
    if (err instanceof ExecutionDeadlineError) {
      log.warn(`Execution deadline exceeded for ${envelope.incident_id}`, {
        incident_id: envelope.incident_id,
        completed: actionsCompleted,
        elapsed_ms: Date.now() - startTime
      });

      // Mark remaining unexecuted actions as skipped
      const executedOrders = new Set(actionResults.map(r => r.order));
      for (const action of sortedActions) {
        if (!executedOrders.has(action.order)) {
          actionResults.push({
            order: action.order,
            action_id: generateActionId(),
            execution_status: 'skipped',
            error_message: 'Execution deadline exceeded'
          });
        }
      }
    } else {
      throw err;
    }
  } finally {
    clearTimeout(deadlineHandle);
  }

  // --- Status computation ---
  const status = computeStatus(actionsCompleted, actionsFailed, actionResults);

  const response = {
    incident_id: envelope.incident_id,
    status,
    actions_completed: actionsCompleted,
    actions_failed: actionsFailed,
    action_results: actionResults
  };

  // Self-validate before returning
  validateExecuteResponse(response);

  const elapsed = Date.now() - startTime;
  log.info(`Executor completed for ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    status,
    actions_completed: actionsCompleted,
    actions_failed: actionsFailed,
    total_actions: sortedActions.length,
    elapsed_ms: elapsed
  });

  return response;
}
