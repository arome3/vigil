// Integration test for the Executor agent.
// Uses real submodules (workflow-router, audit-logger) — only external
// boundaries (ES client, A2A router, contracts, logger) are mocked.
// Verifies that modules compose correctly end-to-end.

import { jest } from '@jest/globals';

// --- Mock ONLY external boundaries ---

const mockSendA2AMessage = jest.fn();
const mockCreateEnvelope = jest.fn();
const mockValidateExecuteResponse = jest.fn();
const mockClientIndex = jest.fn();
const mockClientSearch = jest.fn();

function restoreCreateEnvelope() {
  mockCreateEnvelope.mockImplementation((from, to, corr, payload) => ({
    message_id: `msg-${Date.now()}`,
    from_agent: from,
    to_agent: to,
    timestamp: new Date().toISOString(),
    correlation_id: corr,
    payload
  }));
}

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

// NOTE: approval-gate.js and audit-logger.js are NOT mocked.
// workflow-router.js is a pure function — no mock needed.
// audit-logger.js uses the mocked elastic-client.js above.
// approval-gate.js is mocked because it requires polling and would
// slow integration tests — but everything else is real.
const mockCheckApprovalGate = jest.fn();
jest.unstable_mockModule('../../../src/agents/executor/approval-gate.js', () => ({
  checkApprovalGate: mockCheckApprovalGate
}));

// Dynamic import after mocks
const { handleExecutePlan } = await import('../../../src/agents/executor/handler.js');

// --- Helpers ---

function buildEnvelope(actions) {
  return {
    task: 'execute_plan',
    incident_id: 'INC-2026-INT01',
    remediation_plan: {
      actions,
      success_criteria: [
        { metric: 'error_rate', operator: 'lte', threshold: 1.0, service_name: 'api-gw' }
      ]
    }
  };
}

// --- Test Suite ---

describe('Executor integration', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    restoreCreateEnvelope();
    mockSendA2AMessage.mockResolvedValue({ result_summary: 'Workflow completed' });
    mockCheckApprovalGate.mockResolvedValue({
      status: 'approved', decided_by: '@sre-oncall', decided_at: '2026-02-17T14:00:00Z'
    });
    mockClientIndex.mockResolvedValue({ result: 'created' });
  });

  // ── Real workflow routing ─────────────────────────────────

  test('routes each action to the correct workflow via real routeAction', async () => {
    const actions = [
      {
        order: 1,
        action_type: 'containment',
        description: 'Block malicious IP',
        target_system: 'cloudflare',
        target_asset: '198.51.100.42',
        approval_required: false,
        rollback_steps: 'Remove IP from blocklist'
      },
      {
        order: 2,
        action_type: 'remediation',
        description: 'Rollback api-gateway',
        target_system: 'kubernetes',
        target_asset: 'api-gateway',
        approval_required: false,
        rollback_steps: 'Re-deploy previous version'
      },
      {
        order: 3,
        action_type: 'communication',
        description: 'Notify #incidents channel',
        target_system: 'slack',
        target_asset: '#vigil-incidents',
        approval_required: false,
        rollback_steps: 'N/A'
      },
      {
        order: 4,
        action_type: 'documentation',
        description: 'Create JIRA ticket',
        target_system: 'jira',
        target_asset: 'VIGIL-PROJECT',
        approval_required: false,
        rollback_steps: null
      }
    ];

    const result = await handleExecutePlan(buildEnvelope(actions));

    expect(result.status).toBe('completed');
    expect(result.actions_completed).toBe(4);
    expect(result.actions_failed).toBe(0);
    expect(result.action_results).toHaveLength(4);

    // Verify correct workflow IDs were targeted via createEnvelope calls.
    // sendA2AMessage receives (workflowId, envelope, options) — check the first arg.
    const workflowIds = mockSendA2AMessage.mock.calls.map(c => c[0]);
    expect(workflowIds).toEqual([
      'vigil-wf-containment',
      'vigil-wf-remediation',
      'vigil-wf-notify',
      'vigil-wf-ticketing'
    ]);
  });

  // ── Real audit logging via mocked ES client ───────────────

  test('audit records flow through real logAuditRecord to ES client', async () => {
    const actions = [
      {
        order: 1,
        action_type: 'remediation',
        description: 'Rollback api-gateway',
        target_system: 'kubernetes',
        target_asset: 'api-gateway',
        approval_required: false,
        rollback_steps: 'Re-deploy previous version'
      }
    ];

    await handleExecutePlan(buildEnvelope(actions));

    // Real logAuditRecord calls client.index — verify it reached the ES mock
    expect(mockClientIndex).toHaveBeenCalledTimes(1);
    const indexCall = mockClientIndex.mock.calls[0][0];

    // Verify audit record shape from real audit-logger
    expect(indexCall.index).toBe('vigil-actions');
    expect(indexCall.refresh).toBe(false);

    const doc = indexCall.document;
    expect(doc['@timestamp']).toBeDefined();
    expect(doc.agent_name).toBe('vigil-executor');
    expect(doc.action_type).toBe('remediation');
    expect(doc.target_system).toBe('kubernetes');
    expect(doc.target_asset).toBe('api-gateway');
    expect(doc.execution_status).toBe('completed');
    expect(doc.incident_id).toBe('INC-2026-INT01');
    expect(doc.action_id).toMatch(/^ACT-\d{4}-[A-Z0-9]{5}$/);
    expect(typeof doc.duration_ms).toBe('number');
    expect(doc.rollback_available).toBe(true);
  });

  // ── rollback_available computation with real helpers ───────

  test('rollback_available is false when rollback_steps is N/A', async () => {
    const actions = [
      {
        order: 1,
        action_type: 'communication',
        description: 'Notify channel',
        target_system: 'slack',
        target_asset: '#incidents',
        approval_required: false,
        rollback_steps: 'N/A'
      }
    ];

    await handleExecutePlan(buildEnvelope(actions));

    const doc = mockClientIndex.mock.calls[0][0].document;
    expect(doc.rollback_available).toBe(false);
  });

  // ── Approval → execution → audit pipeline ─────────────────

  test('approval decision propagates through audit record', async () => {
    const actions = [
      {
        order: 1,
        action_type: 'containment',
        description: 'Block IP range',
        target_system: 'cloudflare',
        target_asset: '198.51.100.0/24',
        approval_required: true,
        rollback_steps: 'Remove blocklist entry'
      }
    ];

    await handleExecutePlan(buildEnvelope(actions));

    // Real audit record should include approval metadata
    const doc = mockClientIndex.mock.calls[0][0].document;
    expect(doc.approval_required).toBe(true);
    expect(doc.approved_by).toBe('@sre-oncall');
    expect(doc.approved_at).toBe('2026-02-17T14:00:00Z');
    expect(doc.execution_status).toBe('completed');
  });

  // ── Failure audit records ─────────────────────────────────

  test('failed action writes correct audit record through real pipeline', async () => {
    mockSendA2AMessage.mockRejectedValueOnce(
      new Error('Cloudflare API rate limited')
    );

    const actions = [
      {
        order: 1,
        action_type: 'containment',
        description: 'Block IP',
        target_system: 'cloudflare',
        approval_required: false,
        rollback_steps: null
      }
    ];

    const result = await handleExecutePlan(buildEnvelope(actions));

    expect(result.status).toBe('failed');

    const doc = mockClientIndex.mock.calls[0][0].document;
    expect(doc.execution_status).toBe('failed');
    expect(doc.error_message).toBe('Cloudflare API rate limited');
    expect(doc.rollback_available).toBe(false);
    expect(doc.target_asset).toBeNull();
  });

  // ── Resilience: ES failure doesn't halt execution ─────────

  test('ES client failure for audit does not halt action execution', async () => {
    mockClientIndex.mockRejectedValue(new Error('ES cluster red'));

    const actions = [
      {
        order: 1,
        action_type: 'remediation',
        description: 'Rollback deploy',
        target_system: 'kubernetes',
        target_asset: 'api-gw',
        approval_required: false,
        rollback_steps: 'Re-deploy'
      },
      {
        order: 2,
        action_type: 'communication',
        description: 'Notify',
        target_system: 'slack',
        target_asset: '#channel',
        approval_required: false,
        rollback_steps: 'N/A'
      }
    ];

    const result = await handleExecutePlan(buildEnvelope(actions));

    // Both actions completed despite audit failures
    expect(result.status).toBe('completed');
    expect(result.actions_completed).toBe(2);

    // Audit was attempted for both
    expect(mockClientIndex).toHaveBeenCalledTimes(2);
  });

  // ── End-to-end envelope content ───────────────────────────

  test('workflow envelope contains correct task and action params', async () => {
    const actions = [
      {
        order: 1,
        action_type: 'remediation',
        description: 'Rollback api-gateway',
        target_system: 'kubernetes',
        target_asset: 'api-gateway',
        params: { commit_sha: 'abc123', namespace: 'production' },
        approval_required: false,
        rollback_steps: 'Re-deploy'
      }
    ];

    await handleExecutePlan(buildEnvelope(actions));

    // createEnvelope is called for the workflow dispatch
    // The call includes the routed params from real routeAction
    const envelopeCall = mockCreateEnvelope.mock.calls.find(
      c => c[1] === 'vigil-wf-remediation'
    );
    expect(envelopeCall).toBeDefined();

    const [from, to, corrId, payload] = envelopeCall;
    expect(from).toBe('vigil-executor');
    expect(to).toBe('vigil-wf-remediation');
    expect(corrId).toBe('INC-2026-INT01');
    expect(payload.task).toBe('remediation');
    expect(payload.incident_id).toBe('INC-2026-INT01');
    expect(payload.action_id).toMatch(/^ACT-\d{4}-[A-Z0-9]{5}$/);
    expect(payload.description).toBe('Rollback api-gateway');
    expect(payload.target_system).toBe('kubernetes');
    expect(payload.target_asset).toBe('api-gateway');
    expect(payload.params).toEqual({ commit_sha: 'abc123', namespace: 'production' });
    expect(payload.rollback_steps).toBe('Re-deploy');
  });
});
