// Jest test suite for the Executor agent handler.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/executor/

import { jest } from '@jest/globals';

// --- Mock external dependencies BEFORE importing handler ---

const mockSendA2AMessage = jest.fn();
const mockCreateEnvelope = jest.fn(
  (from, to, corr, payload) => ({
    message_id: 'msg-test',
    from_agent: from,
    to_agent: to,
    timestamp: new Date().toISOString(),
    correlation_id: corr,
    payload
  })
);
const mockValidateExecuteResponse = jest.fn(() => true);
const mockLogAuditRecord = jest.fn();
const mockCheckApprovalGate = jest.fn();
const mockClientIndex = jest.fn();
const mockClientSearch = jest.fn();

jest.unstable_mockModule('../../../src/a2a/router.js', () => ({
  sendA2AMessage: mockSendA2AMessage
}));

jest.unstable_mockModule('../../../src/a2a/message-envelope.js', () => ({
  createEnvelope: mockCreateEnvelope
}));

jest.unstable_mockModule('../../../src/a2a/contracts.js', () => ({
  validateExecuteResponse: mockValidateExecuteResponse,
  ContractValidationError: class extends Error {
    constructor(contract, errors) {
      super(`Contract validation failed [${contract}]: ${errors.join('; ')}`);
      this.name = 'ContractValidationError';
    }
  }
}));

jest.unstable_mockModule('../../../src/agents/executor/audit-logger.js', () => ({
  logAuditRecord: mockLogAuditRecord
}));

jest.unstable_mockModule('../../../src/agents/executor/approval-gate.js', () => ({
  checkApprovalGate: mockCheckApprovalGate
}));

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: {
    index: mockClientIndex,
    search: mockClientSearch
  }
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

// Dynamic import after mocks are set up
const { handleExecutePlan } = await import('../../../src/agents/executor/handler.js');

// --- Test Helpers ---

function buildValidEnvelope(overrides = {}) {
  return {
    task: 'execute_plan',
    incident_id: 'INC-2026-TEST1',
    remediation_plan: {
      actions: [
        {
          order: 1,
          action_type: 'remediation',
          description: 'Rollback api-gateway',
          target_system: 'kubernetes',
          target_asset: 'api-gateway',
          params: { action: 'rollback_deploy' },
          approval_required: false,
          rollback_steps: 'Re-deploy previous version'
        },
        {
          order: 2,
          action_type: 'communication',
          description: 'Notify #incidents channel',
          target_system: 'slack',
          target_asset: '#vigil-incidents',
          params: { channel: 'slack' },
          approval_required: false,
          rollback_steps: 'N/A'
        }
      ],
      success_criteria: [
        { metric: 'error_rate', operator: 'lte', threshold: 1.0, service_name: 'api-gateway' }
      ]
    },
    ...overrides
  };
}

// --- Test Suite ---

describe('vigil-executor handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSendA2AMessage.mockResolvedValue({ result_summary: 'Action completed' });
    mockCheckApprovalGate.mockResolvedValue({
      status: 'approved', decided_by: '@sre-oncall', decided_at: '2026-02-17T14:24:15Z'
    });
    // Default: no prior execution records (idempotency guard passes)
    mockClientSearch.mockResolvedValue({ hits: { hits: [] } });
  });

  // ── Request Validation ───────────────────────────────────

  describe('Request Validation', () => {
    test('rejects request with wrong task type', async () => {
      const envelope = buildValidEnvelope({ task: 'wrong_task' });
      await expect(handleExecutePlan(envelope)).rejects.toThrow(
        "Executor received unknown task: 'wrong_task'"
      );
    });

    test('rejects request with missing incident_id', async () => {
      const envelope = buildValidEnvelope({ incident_id: undefined });
      await expect(handleExecutePlan(envelope)).rejects.toThrow(
        'missing required field: incident_id'
      );
    });

    test('rejects request with missing remediation_plan', async () => {
      const envelope = buildValidEnvelope({ remediation_plan: undefined });
      await expect(handleExecutePlan(envelope)).rejects.toThrow(
        'missing required field: remediation_plan'
      );
    });

    test('rejects request with empty actions array', async () => {
      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions = [];
      await expect(handleExecutePlan(envelope)).rejects.toThrow(
        'non-empty actions array'
      );
    });

    test('rejects request with unknown action_type before executing anything', async () => {
      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions = [{
        order: 1,
        action_type: 'destroy',
        description: 'Bad action',
        target_system: 'kubernetes',
        approval_required: false,
        rollback_steps: null
      }];

      const result = await handleExecutePlan(envelope);

      expect(result.status).toBe('failed');
      expect(result.actions_completed).toBe(0);
      expect(result.actions_failed).toBe(1);
      expect(result.action_results[0].execution_status).toBe('failed');
      expect(result.action_results[0].error_message).toContain("Unknown action_type: 'destroy'");
      expect(result.action_results[0].error_message).toContain('Valid types:');
      // Verify no workflows were called
      expect(mockSendA2AMessage).not.toHaveBeenCalled();
    });

    test('rejects request with action missing required fields', async () => {
      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions = [{
        order: 1,
        action_type: 'remediation',
        // description is missing
        target_system: 'kubernetes',
        approval_required: false
      }];

      await expect(handleExecutePlan(envelope)).rejects.toThrow(
        'missing required field: description'
      );
    });
  });

  // ── Happy Path ───────────────────────────────────────────

  describe('Happy Path', () => {
    test('executes 2 actions sequentially and returns status: completed', async () => {
      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      expect(result.incident_id).toBe('INC-2026-TEST1');
      expect(result.status).toBe('completed');
      expect(result.actions_completed).toBe(2);
      expect(result.actions_failed).toBe(0);
      expect(result.action_results).toHaveLength(2);
      expect(result.action_results[0].execution_status).toBe('completed');
      expect(result.action_results[1].execution_status).toBe('completed');

      // Verify workflows were called in order
      expect(mockSendA2AMessage).toHaveBeenCalledTimes(2);
    });

    test('sorts actions by order field before execution', async () => {
      const envelope = buildValidEnvelope();
      // Reverse the order in the array
      envelope.remediation_plan.actions = [
        {
          order: 3,
          action_type: 'communication',
          description: 'Notify channel',
          target_system: 'slack',
          target_asset: '#incidents',
          approval_required: false,
          rollback_steps: 'N/A'
        },
        {
          order: 1,
          action_type: 'remediation',
          description: 'Rollback deploy',
          target_system: 'kubernetes',
          target_asset: 'api-gateway',
          approval_required: false,
          rollback_steps: 'Re-deploy'
        }
      ];

      const result = await handleExecutePlan(envelope);

      // First result should be order 1 (remediation), second order 3 (communication)
      expect(result.action_results[0].order).toBe(1);
      expect(result.action_results[1].order).toBe(3);
    });

    test('generates unique action IDs for each action', async () => {
      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      const ids = result.action_results.map(r => r.action_id);
      expect(ids[0]).toMatch(/^ACT-\d{4}-[A-Z0-9]{5}$/);
      expect(ids[1]).toMatch(/^ACT-\d{4}-[A-Z0-9]{5}$/);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  // ── Stop-on-Failure ──────────────────────────────────────

  describe('Stop-on-Failure', () => {
    test('stops on first workflow failure and returns status: partial_failure', async () => {
      mockSendA2AMessage
        .mockResolvedValueOnce({ result_summary: 'Action 1 done' })
        .mockRejectedValueOnce(new Error('Kubernetes API returned 503'));

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      expect(result.status).toBe('partial_failure');
      expect(result.actions_completed).toBe(1);
      expect(result.actions_failed).toBe(1);
      expect(result.action_results[0].execution_status).toBe('completed');
      expect(result.action_results[1].execution_status).toBe('failed');
      expect(result.action_results[1].error_message).toContain('Kubernetes API returned 503');
    });

    test('returns status: failed when first action fails (0 completed)', async () => {
      mockSendA2AMessage.mockRejectedValueOnce(new Error('Connection refused'));

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      expect(result.status).toBe('failed');
      expect(result.actions_completed).toBe(0);
      expect(result.actions_failed).toBe(1);
    });

    test('does not execute subsequent actions after failure', async () => {
      mockSendA2AMessage.mockRejectedValueOnce(new Error('Workflow error'));

      const envelope = buildValidEnvelope();
      await handleExecutePlan(envelope);

      // Only called once (first action), not twice
      expect(mockSendA2AMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── Approval Gate ────────────────────────────────────────

  describe('Approval Gate', () => {
    test('calls approval gate for actions with approval_required=true', async () => {
      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions[0].approval_required = true;

      await handleExecutePlan(envelope);

      expect(mockCheckApprovalGate).toHaveBeenCalledTimes(1);
      expect(mockCheckApprovalGate).toHaveBeenCalledWith(
        'INC-2026-TEST1',
        expect.objectContaining({ approval_required: true }),
        expect.stringMatching(/^ACT-\d{4}-[A-Z0-9]{5}$/)
      );
    });

    test('skips approval gate for actions with approval_required=false', async () => {
      const envelope = buildValidEnvelope();
      // Both actions already have approval_required: false

      await handleExecutePlan(envelope);

      expect(mockCheckApprovalGate).not.toHaveBeenCalled();
    });

    test('stops execution when approval is rejected', async () => {
      mockCheckApprovalGate.mockResolvedValue({
        status: 'rejected', decided_by: '@security-lead', decided_at: '2026-02-17T14:30:00Z'
      });

      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions[0].approval_required = true;

      const result = await handleExecutePlan(envelope);

      expect(result.action_results[0].execution_status).toBe('skipped');
      expect(result.action_results[0].error_message).toContain('Approval rejected');
      expect(result.action_results[0].error_message).toContain('@security-lead');
      // Second action should not have been attempted
      expect(mockSendA2AMessage).not.toHaveBeenCalled();
    });

    test('stops execution when approval times out', async () => {
      mockCheckApprovalGate.mockResolvedValue({
        status: 'timeout', decided_by: null, decided_at: null
      });

      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions[0].approval_required = true;

      const result = await handleExecutePlan(envelope);

      expect(result.action_results[0].execution_status).toBe('skipped');
      expect(result.action_results[0].error_message).toContain('Approval timed out');
      expect(mockSendA2AMessage).not.toHaveBeenCalled();
    });
  });

  // ── Audit Logging ────────────────────────────────────────

  describe('Audit Logging', () => {
    test('logs audit record for every action, including failed ones', async () => {
      mockSendA2AMessage
        .mockResolvedValueOnce({ result_summary: 'Done' })
        .mockRejectedValueOnce(new Error('Failed'));

      const envelope = buildValidEnvelope();
      await handleExecutePlan(envelope);

      // logAuditRecord called for both actions (success and failure)
      expect(mockLogAuditRecord).toHaveBeenCalledTimes(2);

      // First call: completed
      expect(mockLogAuditRecord.mock.calls[0][0]).toMatchObject({
        execution_status: 'completed',
        incident_id: 'INC-2026-TEST1'
      });

      // Second call: failed
      expect(mockLogAuditRecord.mock.calls[1][0]).toMatchObject({
        execution_status: 'failed',
        incident_id: 'INC-2026-TEST1'
      });
    });

    test('audit record includes correct duration_ms calculation', async () => {
      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions = [envelope.remediation_plan.actions[0]];

      await handleExecutePlan(envelope);

      expect(mockLogAuditRecord).toHaveBeenCalledTimes(1);
      const record = mockLogAuditRecord.mock.calls[0][0];

      expect(typeof record.duration_ms).toBe('number');
      expect(record.duration_ms).toBeGreaterThanOrEqual(0);
      expect(record.started_at).toBeDefined();
      expect(record.completed_at).toBeDefined();
    });

    test('execution continues even if audit logging throws', async () => {
      // logAuditRecord is already mocked to not throw, matching its real behavior.
      // This test verifies the handler does not break if the mock rejects.
      mockLogAuditRecord.mockImplementation(() => {
        throw new Error('ES connection lost');
      });

      const envelope = buildValidEnvelope();
      // Since logAuditRecord is fire-and-forget (no await in catch path),
      // the handler should still complete
      const result = await handleExecutePlan(envelope);

      // Handler should still complete successfully despite audit errors
      expect(result.status).toBe('completed');
      expect(result.actions_completed).toBe(2);
    });
  });

  // ── Response Validation ──────────────────────────────────

  describe('Response Validation', () => {
    test('response passes validateExecuteResponse() contract validation', async () => {
      const envelope = buildValidEnvelope();
      await handleExecutePlan(envelope);

      expect(mockValidateExecuteResponse).toHaveBeenCalledTimes(1);
      expect(mockValidateExecuteResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          incident_id: 'INC-2026-TEST1',
          status: 'completed',
          actions_completed: 2,
          actions_failed: 0,
          action_results: expect.any(Array)
        })
      );
    });

    test('action_results array contains entry for every attempted action', async () => {
      mockSendA2AMessage
        .mockResolvedValueOnce({ result_summary: 'Done' })
        .mockRejectedValueOnce(new Error('Fail'));

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      expect(result.action_results).toHaveLength(2);
      expect(result.action_results[0]).toMatchObject({
        order: 1,
        action_id: expect.stringMatching(/^ACT-/),
        execution_status: 'completed',
        error_message: null
      });
      expect(result.action_results[1]).toMatchObject({
        order: 2,
        action_id: expect.stringMatching(/^ACT-/),
        execution_status: 'failed',
        error_message: expect.stringContaining('Fail')
      });
    });
  });

  // ── Idempotency ──────────────────────────────────────────

  describe('Idempotency', () => {
    test('skips execution when audit records already exist for incident', async () => {
      mockClientSearch.mockResolvedValue({
        hits: { hits: [{ _source: { incident_id: 'INC-2026-TEST1', action_id: 'ACT-2026-PRIOR' } }] }
      });

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      expect(result.status).toBe('completed');
      expect(result.actions_completed).toBe(0);
      expect(result.actions_failed).toBe(0);
      expect(result.action_results).toEqual([]);
      // No workflows should have been called
      expect(mockSendA2AMessage).not.toHaveBeenCalled();
    });

    test('proceeds when no prior execution records exist', async () => {
      mockClientSearch.mockResolvedValue({ hits: { hits: [] } });

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      expect(result.status).toBe('completed');
      expect(result.actions_completed).toBe(2);
      expect(mockSendA2AMessage).toHaveBeenCalledTimes(2);
    });

    test('proceeds when ES is unavailable (guard failure is non-blocking)', async () => {
      mockClientSearch.mockRejectedValue(new Error('ES cluster unavailable'));

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope);

      // Should still execute normally despite idempotency check failure
      expect(result.status).toBe('completed');
      expect(result.actions_completed).toBe(2);
      expect(mockSendA2AMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ── Deadline ─────────────────────────────────────────────

  describe('Deadline', () => {
    test('returns partial results when execution deadline is exceeded', async () => {
      // Use the injectable options.deadlineMs to exercise the real
      // Promise.race path: action 1 resolves instantly, action 2 is
      // deliberately slow (200ms), and the 50ms deadline fires mid-flight.
      const envelope = buildValidEnvelope();
      envelope.remediation_plan.actions.push({
        order: 3,
        action_type: 'documentation',
        description: 'Create JIRA ticket',
        target_system: 'jira',
        target_asset: 'VIGIL-123',
        approval_required: false,
        rollback_steps: null
      });

      // Action 1: resolves instantly
      // Action 2+: takes 500ms (will be in-flight when 50ms deadline fires)
      mockSendA2AMessage
        .mockResolvedValueOnce({ result_summary: 'Rollback completed' })
        .mockImplementation(
          () => new Promise(resolve =>
            setTimeout(() => resolve({ result_summary: 'Slow' }), 500)
          )
        );

      const result = await handleExecutePlan(envelope, { deadlineMs: 50 });

      // Action 1 completed before the deadline fired
      const completed = result.action_results.filter(
        r => r.execution_status === 'completed'
      );
      expect(completed.length).toBe(1);
      expect(completed[0].order).toBe(1);

      // Remaining actions marked as skipped with the deadline error
      const skipped = result.action_results.filter(
        r => r.execution_status === 'skipped'
      );
      expect(skipped.length).toBeGreaterThanOrEqual(1);
      expect(
        skipped.every(r => r.error_message === 'Execution deadline exceeded')
      ).toBe(true);

      // Status reflects partial completion (actionsCompleted > 0 + skipped)
      expect(result.status).toBe('partial_failure');
    });

    test('marks all actions as skipped when deadline fires before any complete', async () => {
      // All workflows are slow — deadline fires before the first completes
      mockSendA2AMessage.mockImplementation(
        () => new Promise(resolve =>
          setTimeout(() => resolve({ result_summary: 'Slow' }), 500)
        )
      );

      const envelope = buildValidEnvelope();
      const result = await handleExecutePlan(envelope, { deadlineMs: 10 });

      // No actions completed
      expect(result.actions_completed).toBe(0);

      // All actions should be skipped
      const skipped = result.action_results.filter(
        r => r.execution_status === 'skipped'
      );
      expect(skipped.length).toBe(2);
      expect(
        skipped.every(r => r.error_message === 'Execution deadline exceeded')
      ).toBe(true);

      // Status is failed (0 completed)
      expect(result.status).toBe('failed');
    });
  });
});
