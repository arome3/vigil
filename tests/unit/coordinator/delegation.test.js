import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════
// Mock functions
// ═══════════════════════════════════════════════════════════════

const mockTransitionIncident = mock.fn();
const mockGetIncident = mock.fn();
const mockEvaluateGuard = mock.fn();
const mockSendA2AMessage = mock.fn();
const mockCreateEnvelope = mock.fn((_from, _to, _corr, payload) => ({
  message_id: 'msg-test', from_agent: _from, to_agent: _to,
  timestamp: '2026-02-20T10:00:00.000Z', correlation_id: _corr, payload
}));
const mockEscalateIncident = mock.fn();
const mockCheckConflictingAssessments = mock.fn();
const mockCheckApprovalTimeout = mock.fn();
const mockComputeTimingMetrics = mock.fn();
const mockClientIndex = mock.fn();
const mockClientUpdate = mock.fn();
const mockClientSearch = mock.fn();
const mockUuidV4 = mock.fn(() => 'aaaaa-bbbb-cccc-dddd-eeeeeeee');

// Contract mocks — pass-through builders, no-op validators
const mockBuildInvestigateRequest = mock.fn((...args) => ({ task: 'investigate', incident_id: args[0] }));
const mockValidateInvestigateResponse = mock.fn();
const mockBuildSweepRequest = mock.fn((...args) => ({ task: 'sweep_environment', incident_id: args[0] }));
const mockValidateSweepResponse = mock.fn();
const mockBuildPlanRequest = mock.fn((...args) => ({ task: 'plan_remediation', incident_id: args[0] }));
const mockValidatePlanResponse = mock.fn();
const mockBuildExecuteRequest = mock.fn((...args) => ({ task: 'execute_plan', incident_id: args[0] }));
const mockValidateExecuteResponse = mock.fn();
const mockBuildVerifyRequest = mock.fn((...args) => ({ task: 'verify_resolution', incident_id: args[0] }));
const mockValidateVerifyResponse = mock.fn();

// ═══════════════════════════════════════════════════════════════
// Register mocks before importing module under test
// ═══════════════════════════════════════════════════════════════

mock.module(import.meta.resolve('../../../src/state-machine/transitions.js'), {
  namedExports: {
    transitionIncident: mockTransitionIncident,
    getIncident: mockGetIncident
  }
});

mock.module(import.meta.resolve('../../../src/state-machine/guards.js'), {
  namedExports: { evaluateGuard: mockEvaluateGuard }
});

mock.module(import.meta.resolve('../../../src/a2a/router.js'), {
  namedExports: { sendA2AMessage: mockSendA2AMessage }
});

mock.module(import.meta.resolve('../../../src/a2a/message-envelope.js'), {
  namedExports: { createEnvelope: mockCreateEnvelope }
});

mock.module(import.meta.resolve('../../../src/a2a/contracts.js'), {
  namedExports: {
    buildInvestigateRequest: mockBuildInvestigateRequest,
    validateInvestigateResponse: mockValidateInvestigateResponse,
    buildSweepRequest: mockBuildSweepRequest,
    validateSweepResponse: mockValidateSweepResponse,
    buildPlanRequest: mockBuildPlanRequest,
    validatePlanResponse: mockValidatePlanResponse,
    buildExecuteRequest: mockBuildExecuteRequest,
    validateExecuteResponse: mockValidateExecuteResponse,
    buildVerifyRequest: mockBuildVerifyRequest,
    validateVerifyResponse: mockValidateVerifyResponse
  }
});

mock.module(import.meta.resolve('../../../src/agents/coordinator/escalation.js'), {
  namedExports: {
    escalateIncident: mockEscalateIncident,
    checkConflictingAssessments: mockCheckConflictingAssessments,
    checkApprovalTimeout: mockCheckApprovalTimeout
  }
});

mock.module(import.meta.resolve('../../../src/agents/coordinator/timing.js'), {
  namedExports: { computeTimingMetrics: mockComputeTimingMetrics }
});

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: { index: mockClientIndex, update: mockClientUpdate, search: mockClientSearch }
});

mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}
    })
  }
});

mock.module(import.meta.resolve('../../../src/utils/env.js'), {
  namedExports: {
    parseThreshold: (_name, def) => def,
    parsePositiveInt: (_name, def) => def
  }
});

mock.module('uuid', { namedExports: { v4: mockUuidV4 } });

// ═══════════════════════════════════════════════════════════════
// Import module under test
// ═══════════════════════════════════════════════════════════════

const {
  orchestrateSecurityIncident,
  orchestrateOperationalIncident,
  handleReflectionLoop
} = await import('../../../src/agents/coordinator/delegation.js');

// ═══════════════════════════════════════════════════════════════
// Test helpers / factories
// ═══════════════════════════════════════════════════════════════

function makeTriageResponse(overrides = {}) {
  return {
    alert_id: 'ALERT-001',
    priority_score: 0.87,
    disposition: 'investigate',
    alert_timestamp: '2026-02-20T10:00:00.000Z',
    enrichment: {
      correlated_event_count: 5,
      unique_destinations: 3,
      failed_auth_count: 2,
      risk_signal: 0.8,
      historical_fp_rate: 0.1,
      asset_criticality: 'tier-1',
      source_ip: '10.0.0.5',
      source_user: 'jdoe'
    },
    ...overrides
  };
}

function makeInvestigatorResponse(overrides = {}) {
  return {
    investigation_id: 'INV-001',
    incident_id: 'INC-2026-AAAAA',
    root_cause: 'Credential theft via phishing',
    attack_chain: [{ step: 1, description: 'Initial access' }],
    blast_radius: [{ asset_id: 'web-1', impact_type: 'compromised', confidence: 0.9 }],
    recommended_next: 'plan_remediation',
    threat_intel_matches: [],
    change_correlation: { matched: false },
    ...overrides
  };
}

function makeThreatHunterResponse(overrides = {}) {
  return {
    incident_id: 'INC-2026-AAAAA',
    confirmed_compromised: [{ asset_id: 'web-1' }],
    suspected_compromised: [],
    total_assets_scanned: 100,
    clean_assets: 99,
    ...overrides
  };
}

function makeCommanderResponse(overrides = {}) {
  return {
    incident_id: 'INC-2026-AAAAA',
    remediation_plan: {
      actions: [
        { order: 1, action_type: 'isolate_host', description: 'Isolate web-1', target_system: 'web-1', approval_required: false }
      ],
      success_criteria: [
        { metric: 'host_isolated', operator: 'eq', threshold: true, service_name: 'web-1' }
      ]
    },
    ...overrides
  };
}

function makeExecutorResponse(overrides = {}) {
  return {
    incident_id: 'INC-2026-AAAAA',
    status: 'completed',
    actions_completed: 1,
    actions_failed: 0,
    action_results: [{ action_type: 'isolate_host', status: 'success' }],
    ...overrides
  };
}

function makeVerifierResponse(passed, overrides = {}) {
  return {
    incident_id: 'INC-2026-AAAAA',
    iteration: 1,
    health_score: passed ? 0.95 : 0.3,
    passed,
    criteria_results: [],
    ...(passed ? {} : { failure_analysis: 'Host still reachable' }),
    ...overrides
  };
}

function makeIncidentDoc(overrides = {}) {
  return {
    incident_id: 'INC-2026-AAAAA',
    status: 'detected',
    incident_type: 'security',
    severity: 'high',
    priority_score: 0.87,
    alert_ids: ['ALERT-001'],
    affected_services: ['web-1'],
    investigation_summary: null,
    remediation_plan: null,
    verification_results: [],
    reflection_count: 0,
    escalation_triggered: false,
    resolution_type: null,
    resolved_at: null,
    created_at: '2026-02-20T10:00:00.000Z',
    _state_timestamps: { detected: '2026-02-20T10:00:00.000Z' },
    ...overrides
  };
}

const FIXED_METRICS = {
  ttd_seconds: 30, tti_seconds: 120, ttr_seconds: 90,
  ttv_seconds: 30, total_duration_seconds: 600
};

// Agent-based mock routing
function setupAgentRouting(agentOverrides = {}) {
  mockSendA2AMessage.mock.mockImplementation(async (agentId) => {
    if (agentOverrides[agentId]) return agentOverrides[agentId]();
    switch (agentId) {
      case 'vigil-investigator': return makeInvestigatorResponse();
      case 'vigil-threat-hunter': return makeThreatHunterResponse();
      case 'vigil-commander': return makeCommanderResponse();
      case 'vigil-executor': return makeExecutorResponse();
      case 'vigil-verifier': return makeVerifierResponse(true);
      case 'vigil-wf-approval': return { status: 'sent' };
      default: return { status: 'sent' };
    }
  });
}

function setupDefaultMocks() {
  // Transition returns updated doc shape
  mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
    makeIncidentDoc({ status: newStatus })
  );

  // getIncident returns doc with concurrency tokens
  mockGetIncident.mock.mockImplementation(async () => ({
    doc: makeIncidentDoc(), _seq_no: 1, _primary_term: 1
  }));

  // Guard: by default deny suppress, deny approval, allow resolve
  mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
    if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above threshold' };
    if (from === 'planning' && to === 'awaiting_approval') return { allowed: false, redirectTo: null, reason: 'no approval needed' };
    if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
    return { allowed: true, redirectTo: null, reason: 'default allow' };
  });

  mockEscalateIncident.mock.mockImplementation(async () => ({ skipped: false, reason: 'test' }));
  mockCheckConflictingAssessments.mock.mockImplementation(() => ({ conflicting: false }));
  mockComputeTimingMetrics.mock.mockImplementation(() => FIXED_METRICS);
  mockClientIndex.mock.mockImplementation(async () => ({ result: 'created' }));
  mockClientUpdate.mock.mockImplementation(async () => ({ result: 'updated' }));

  setupAgentRouting();
}

function resetAllMocks() {
  for (const fn of [
    mockTransitionIncident, mockGetIncident, mockEvaluateGuard,
    mockSendA2AMessage, mockCreateEnvelope, mockEscalateIncident,
    mockCheckConflictingAssessments, mockCheckApprovalTimeout,
    mockComputeTimingMetrics, mockClientIndex, mockClientUpdate, mockClientSearch,
    mockBuildInvestigateRequest, mockValidateInvestigateResponse,
    mockBuildSweepRequest, mockValidateSweepResponse,
    mockBuildPlanRequest, mockValidatePlanResponse,
    mockBuildExecuteRequest, mockValidateExecuteResponse,
    mockBuildVerifyRequest, mockValidateVerifyResponse
  ]) {
    fn.mock.resetCalls();
    fn.mock.restore();
  }
}

// ═══════════════════════════════════════════════════════════════
// Tests: orchestrateSecurityIncident
// ═══════════════════════════════════════════════════════════════

describe('orchestrateSecurityIncident', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  it('suppresses alerts with priority_score below threshold', async () => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: true, redirectTo: null, reason: 'below threshold' };
      return { allowed: false, redirectTo: null, reason: 'default' };
    });

    const result = await orchestrateSecurityIncident(makeTriageResponse({ priority_score: 0.2 }));

    assert.equal(result.status, 'suppressed');
    assert.ok(result.incidentId);
  });

  it('creates incident document and transitions through detected->triaged->investigating', async () => {
    await orchestrateSecurityIncident(makeTriageResponse());

    assert.equal(mockClientIndex.mock.callCount(), 1);
    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(transitions.includes('triaged'));
    assert.ok(transitions.includes('investigating'));
  });

  it('delegates to Investigator with correct alert context', async () => {
    await orchestrateSecurityIncident(makeTriageResponse());

    const investigatorCalls = mockSendA2AMessage.mock.calls.filter(
      c => c.arguments[0] === 'vigil-investigator'
    );
    assert.equal(investigatorCalls.length, 1);
  });

  it('transitions to threat_hunting when investigator recommends threat_hunt', async () => {
    setupAgentRouting({
      'vigil-investigator': () => makeInvestigatorResponse({ recommended_next: 'threat_hunt' })
    });

    await orchestrateSecurityIncident(makeTriageResponse());

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(transitions.includes('threat_hunting'));
  });

  it('skips threat hunting when investigator recommends plan_remediation', async () => {
    await orchestrateSecurityIncident(makeTriageResponse());

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(!transitions.includes('threat_hunting'));
    assert.ok(transitions.includes('planning'));
  });

  it('escalates on conflicting assessments between investigator and threat hunter', async () => {
    setupAgentRouting({
      'vigil-investigator': () => makeInvestigatorResponse({ recommended_next: 'threat_hunt' })
    });
    mockCheckConflictingAssessments.mock.mockImplementation(() => ({
      conflicting: true,
      reason: 'Divergent scope'
    }));

    const result = await orchestrateSecurityIncident(makeTriageResponse());

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'conflicting_assessments');
    assert.ok(mockEscalateIncident.mock.callCount() >= 1);
  });

  it('escalates when investigation agent fails', async () => {
    setupAgentRouting({
      'vigil-investigator': () => { throw new Error('agent unavailable'); }
    });

    const result = await orchestrateSecurityIncident(makeTriageResponse());

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'investigation_failed');
  });

  it('returns resolved status on successful end-to-end flow', async () => {
    const result = await orchestrateSecurityIncident(makeTriageResponse());

    assert.equal(result.status, 'resolved');
    assert.ok(result.incidentId);
    assert.deepEqual(result.metrics, FIXED_METRICS);
  });

  it('transitions in correct order for full security flow', async () => {
    await orchestrateSecurityIncident(makeTriageResponse());

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    const expectedOrder = ['triaged', 'investigating', 'planning', 'executing', 'verifying', 'resolved'];

    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const idxA = transitions.indexOf(expectedOrder[i]);
      const idxB = transitions.indexOf(expectedOrder[i + 1]);
      assert.ok(idxA >= 0, `${expectedOrder[i]} should appear in transitions`);
      assert.ok(idxB >= 0, `${expectedOrder[i + 1]} should appear in transitions`);
      assert.ok(idxA < idxB,
        `${expectedOrder[i]} (index ${idxA}) should come before ${expectedOrder[i + 1]} (index ${idxB})`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: orchestrateOperationalIncident
// ═══════════════════════════════════════════════════════════════

describe('orchestrateOperationalIncident', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  it('creates operational incident and skips threat hunting', async () => {
    const sentinelReport = {
      anomaly_id: 'ANOM-001',
      detected_at: '2026-02-20T10:00:00.000Z',
      affected_service_tier: 'tier-2',
      affected_assets: ['svc-api'],
      change_correlation: { confidence: 'low' }
    };

    await orchestrateOperationalIncident(sentinelReport);

    const indexCall = mockClientIndex.mock.calls[0];
    assert.equal(indexCall.arguments[0].document.incident_type, 'operational');
    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(!transitions.includes('threat_hunting'));
  });

  it('performs light investigation when change correlation confidence is high', async () => {
    const sentinelReport = {
      anomaly_id: 'ANOM-002',
      detected_at: '2026-02-20T10:00:00.000Z',
      affected_assets: ['svc-api'],
      change_correlation: { confidence: 'high', commit_author: 'dev1' }
    };

    await orchestrateOperationalIncident(sentinelReport);

    const investigatorCalls = mockSendA2AMessage.mock.calls.filter(
      c => c.arguments[0] === 'vigil-investigator'
    );
    assert.equal(investigatorCalls.length, 1);
  });

  it('builds synthetic investigation report when investigator skipped', async () => {
    const sentinelReport = {
      anomaly_id: 'ANOM-003',
      detected_at: '2026-02-20T10:00:00.000Z',
      affected_assets: ['svc-api'],
      change_correlation: { confidence: 'low' }
    };

    await orchestrateOperationalIncident(sentinelReport);

    // Commander should still be called even without real investigation
    const commanderCalls = mockSendA2AMessage.mock.calls.filter(
      c => c.arguments[0] === 'vigil-commander'
    );
    assert.equal(commanderCalls.length, 1);
  });

  it('returns resolved status on successful flow', async () => {
    const sentinelReport = {
      anomaly_id: 'ANOM-004',
      detected_at: '2026-02-20T10:00:00.000Z',
      affected_assets: [],
      change_correlation: { confidence: 'low' }
    };

    const result = await orchestrateOperationalIncident(sentinelReport);

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.metrics, FIXED_METRICS);
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: executeFromPlanning (tested via orchestrate*)
// ═══════════════════════════════════════════════════════════════

describe('executeFromPlanning', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  it('delegates to Commander with correct plan request', async () => {
    await orchestrateSecurityIncident(makeTriageResponse());

    const commanderCalls = mockSendA2AMessage.mock.calls.filter(
      c => c.arguments[0] === 'vigil-commander'
    );
    assert.equal(commanderCalls.length, 1);
    assert.ok(mockBuildPlanRequest.mock.callCount() >= 1);
  });

  it('triggers approval gate when plan has approval_required actions', async (t) => {
    // Allow approval gate
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to, _ctx) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above threshold' };
      if (from === 'planning' && to === 'awaiting_approval') return { allowed: true, redirectTo: null, reason: 'approval needed' };
      if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    // Make getIncident return approved status after first poll
    let callCount = 0;
    mockGetIncident.mock.mockImplementation(async () => {
      callCount++;
      if (callCount > 3) {
        return { doc: makeIncidentDoc({ approval_status: 'approved' }), _seq_no: 1, _primary_term: 1 };
      }
      return { doc: makeIncidentDoc(), _seq_no: 1, _primary_term: 1 };
    });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const promise = orchestrateSecurityIncident(makeTriageResponse());
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }
    const result = await promise;

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(transitions.includes('awaiting_approval'));
    assert.equal(result.status, 'resolved');
  });

  it('skips approval gate when no actions require approval', async () => {
    await orchestrateSecurityIncident(makeTriageResponse());

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(!transitions.includes('awaiting_approval'));
  });

  it('escalates when approval is rejected', async (t) => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above' };
      if (from === 'planning' && to === 'awaiting_approval') return { allowed: true, redirectTo: null, reason: 'needed' };
      if (from === 'awaiting_approval' && to === 'escalated') return { allowed: true, redirectTo: null, reason: 'denied' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    mockGetIncident.mock.mockImplementation(async () => ({
      doc: makeIncidentDoc({ approval_status: 'rejected' }), _seq_no: 1, _primary_term: 1
    }));

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const promise = orchestrateSecurityIncident(makeTriageResponse());
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }
    const result = await promise;

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'approval_rejected');
  });

  it('escalates when approval times out', async (t) => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above' };
      if (from === 'planning' && to === 'awaiting_approval') return { allowed: true, redirectTo: null, reason: 'needed' };
      if (from === 'awaiting_approval' && to === 'escalated') return { allowed: true, redirectTo: null, reason: 'timeout' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    // getIncident never returns approved/rejected — forces timeout
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: makeIncidentDoc({ approval_status: 'pending' }), _seq_no: 1, _primary_term: 1
    }));

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const promise = orchestrateSecurityIncident(makeTriageResponse());

    // Advance past the approval timeout (15 min = 900_000 ms)
    for (let i = 0; i < 65; i++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }

    const result = await promise;

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'approval_timeout');
  });

  it('delegates to Executor then Verifier in sequence', async () => {
    const callOrder = [];
    mockSendA2AMessage.mock.mockImplementation(async (agentId) => {
      callOrder.push(agentId);
      switch (agentId) {
        case 'vigil-investigator': return makeInvestigatorResponse();
        case 'vigil-commander': return makeCommanderResponse();
        case 'vigil-executor': return makeExecutorResponse();
        case 'vigil-verifier': return makeVerifierResponse(true);
        default: return { status: 'sent' };
      }
    });

    await orchestrateSecurityIncident(makeTriageResponse());

    const executorIdx = callOrder.indexOf('vigil-executor');
    const verifierIdx = callOrder.indexOf('vigil-verifier');
    assert.ok(executorIdx >= 0, 'executor should be called');
    assert.ok(verifierIdx >= 0, 'verifier should be called');
    assert.ok(executorIdx < verifierIdx, 'executor should be called before verifier');
  });

  it('enters reflection loop on verification failure', async () => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to, ctx) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above' };
      if (from === 'planning' && to === 'awaiting_approval') return { allowed: false, redirectTo: null, reason: 'no' };
      if (from === 'verifying' && to === 'resolved') {
        if (ctx?.verifierResponse?.passed) return { allowed: true, redirectTo: null, reason: 'passed' };
        return { allowed: false, redirectTo: 'reflecting', reason: 'failed' };
      }
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    // First verifier call fails, reflection re-verify passes
    let verifierCallCount = 0;
    setupAgentRouting({
      'vigil-verifier': () => {
        verifierCallCount++;
        return verifierCallCount === 1 ? makeVerifierResponse(false) : makeVerifierResponse(true);
      }
    });

    // transitionIncident returns reflecting status
    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: newStatus === 'reflecting' ? 1 : 0 })
    );

    const result = await orchestrateSecurityIncident(makeTriageResponse());

    assert.equal(result.status, 'resolved');
    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(transitions.includes('reflecting'));
  });

  it('resolves and computes metrics on verification pass', async () => {
    const result = await orchestrateSecurityIncident(makeTriageResponse());

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.metrics, FIXED_METRICS);
    assert.ok(mockComputeTimingMetrics.mock.callCount() >= 1);
    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(transitions.includes('resolved'));
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: handleReflectionLoop
// ═══════════════════════════════════════════════════════════════

describe('handleReflectionLoop', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  const baseArgs = () => [
    'INC-2026-AAAAA',
    makeInvestigatorResponse(),
    makeCommanderResponse(),
    null,  // threatHunterResp
    { alert_ids: ['ALERT-001'] },
    ['web-1'],
    'Host still reachable',
    'security'
  ];

  it('re-investigates with failure analysis from previous iteration', async () => {
    // First reflection resolves
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to, ctx) => {
      if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: 1 })
    );

    await handleReflectionLoop(...baseArgs());

    assert.ok(mockBuildInvestigateRequest.mock.callCount() >= 1);
    const buildCall = mockBuildInvestigateRequest.mock.calls[0];
    assert.equal(buildCall.arguments[3], 'Host still reachable');
  });

  it('skips threat hunting during reflection iterations', async () => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: 1 })
    );

    await handleReflectionLoop(...baseArgs());

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(!transitions.includes('threat_hunting'));
  });

  it('resolves when re-verification passes', async () => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: 1 })
    );

    const result = await handleReflectionLoop(...baseArgs());

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.metrics, FIXED_METRICS);
  });

  it('escalates after exhausting all reflection iterations', async () => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'verifying' && to === 'resolved') return { allowed: false, redirectTo: 'reflecting', reason: 'failed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    let reflectionCount = 0;
    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) => {
      if (newStatus === 'reflecting') reflectionCount++;
      // On 3rd reflection, auto-escalate
      if (newStatus === 'reflecting' && reflectionCount >= 3) {
        return makeIncidentDoc({ status: 'escalated', reflection_count: reflectionCount });
      }
      return makeIncidentDoc({ status: newStatus, reflection_count: reflectionCount });
    });

    const result = await handleReflectionLoop(...baseArgs());

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'reflection_limit_reached');
  });

  it('escalates when re-investigation fails', async () => {
    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: 1 })
    );

    setupAgentRouting({
      'vigil-investigator': () => { throw new Error('agent crash'); }
    });

    const result = await handleReflectionLoop(...baseArgs());

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'reinvestigation_failed');
  });

  it('escalates when re-planning fails', async () => {
    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: 1 })
    );

    setupAgentRouting({
      'vigil-commander': () => { throw new Error('planning crash'); }
    });

    const result = await handleReflectionLoop(...baseArgs());

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'replanning_failed');
  });

  it('retries when re-execution fails mid-reflection', async () => {
    // First executor call throws, second succeeds
    let executorCallCount = 0;
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to, ctx) => {
      if (from === 'verifying' && to === 'resolved') {
        if (ctx?.verifierResponse?.passed) return { allowed: true, redirectTo: null, reason: 'passed' };
        return { allowed: false, redirectTo: 'reflecting', reason: 'failed' };
      }
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    let reflectionCount = 0;
    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) => {
      if (newStatus === 'reflecting') reflectionCount++;
      return makeIncidentDoc({ status: newStatus, reflection_count: reflectionCount });
    });

    setupAgentRouting({
      'vigil-executor': () => {
        executorCallCount++;
        if (executorCallCount === 1) throw new Error('execution timeout');
        return makeExecutorResponse();
      },
      'vigil-verifier': () => makeVerifierResponse(true)
    });

    const result = await handleReflectionLoop(...baseArgs());

    assert.equal(result.status, 'resolved');

    // Verify executor was called at least twice
    const executorCalls = mockSendA2AMessage.mock.calls.filter(
      c => c.arguments[0] === 'vigil-executor'
    );
    assert.ok(executorCalls.length >= 2, 'executor should be called at least twice');

    // Verify buildInvestigateRequest was called with 'Execution failed:' failure analysis
    const investigateCalls = mockBuildInvestigateRequest.mock.calls;
    const executionFailureCall = investigateCalls.find(
      c => c.arguments[3] && c.arguments[3].startsWith('Execution failed:')
    );
    assert.ok(executionFailureCall,
      'should re-investigate with execution failure analysis');
  });

  it('transitions in correct order during reflection', async () => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) =>
      makeIncidentDoc({ status: newStatus, reflection_count: 1 })
    );

    await handleReflectionLoop(...baseArgs());

    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    const expectedOrder = ['reflecting', 'investigating', 'planning', 'executing', 'verifying'];

    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const idxA = transitions.indexOf(expectedOrder[i]);
      const idxB = transitions.indexOf(expectedOrder[i + 1]);
      assert.ok(idxA >= 0, `${expectedOrder[i]} should appear in transitions`);
      assert.ok(idxB >= 0, `${expectedOrder[i + 1]} should appear in transitions`);
      assert.ok(idxA < idxB,
        `${expectedOrder[i]} (index ${idxA}) should come before ${expectedOrder[i + 1]} (index ${idxB})`);
    }
  });

  it('carries forward context across iterations', async () => {
    let verifierCallCount = 0;
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to, ctx) => {
      if (from === 'verifying' && to === 'resolved') {
        if (ctx?.verifierResponse?.passed) return { allowed: true, redirectTo: null, reason: 'passed' };
        return { allowed: false, redirectTo: 'reflecting', reason: 'failed' };
      }
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    let reflectionCount = 0;
    mockTransitionIncident.mock.mockImplementation(async (_id, newStatus) => {
      if (newStatus === 'reflecting') reflectionCount++;
      return makeIncidentDoc({ status: newStatus, reflection_count: reflectionCount });
    });

    setupAgentRouting({
      'vigil-verifier': () => {
        verifierCallCount++;
        return verifierCallCount < 3
          ? makeVerifierResponse(false, { failure_analysis: `Failure iteration ${verifierCallCount}` })
          : makeVerifierResponse(true);
      }
    });

    const result = await handleReflectionLoop(...baseArgs());

    assert.equal(result.status, 'resolved');
    // Verify buildInvestigateRequest was called with updated failure analysis
    const investigateCalls = mockBuildInvestigateRequest.mock.calls;
    assert.ok(investigateCalls.length >= 2);
    // First call gets original failure analysis
    assert.equal(investigateCalls[0].arguments[3], 'Host still reachable');
    // Second call gets failure from first verifier
    assert.equal(investigateCalls[1].arguments[3], 'Failure iteration 1');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: waitForApproval (tested via orchestrateSecurityIncident)
// ═══════════════════════════════════════════════════════════════

describe('waitForApproval', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  function setupApprovalFlow(approvalStatus) {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above' };
      if (from === 'planning' && to === 'awaiting_approval') return { allowed: true, redirectTo: null, reason: 'needed' };
      if (from === 'awaiting_approval' && to === 'escalated') return { allowed: true, redirectTo: null, reason: 'denied' };
      if (from === 'verifying' && to === 'resolved') return { allowed: true, redirectTo: null, reason: 'passed' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: makeIncidentDoc({ approval_status: approvalStatus }), _seq_no: 1, _primary_term: 1
    }));
  }

  it('returns approved when incident approval_status is approved', async (t) => {
    setupApprovalFlow('approved');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const promise = orchestrateSecurityIncident(makeTriageResponse());
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }
    const result = await promise;

    assert.equal(result.status, 'resolved');
    const transitions = mockTransitionIncident.mock.calls.map(c => c.arguments[1]);
    assert.ok(transitions.includes('awaiting_approval'));
  });

  it('returns rejected when incident approval_status is rejected', async (t) => {
    setupApprovalFlow('rejected');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const promise = orchestrateSecurityIncident(makeTriageResponse());
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }
    const result = await promise;

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'approval_rejected');
  });

  it('returns timeout after APPROVAL_TIMEOUT_MINUTES', async (t) => {
    mockEvaluateGuard.mock.mockImplementation((_doc, from, to) => {
      if (from === 'triaged' && to === 'suppressed') return { allowed: false, redirectTo: null, reason: 'above' };
      if (from === 'planning' && to === 'awaiting_approval') return { allowed: true, redirectTo: null, reason: 'needed' };
      if (from === 'awaiting_approval' && to === 'escalated') return { allowed: true, redirectTo: null, reason: 'timeout' };
      return { allowed: true, redirectTo: null, reason: 'default' };
    });

    mockGetIncident.mock.mockImplementation(async () => ({
      doc: makeIncidentDoc({ approval_status: 'pending' }), _seq_no: 1, _primary_term: 1
    }));

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const promise = orchestrateSecurityIncident(makeTriageResponse());

    for (let i = 0; i < 65; i++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }

    const result = await promise;

    assert.equal(result.status, 'escalated');
    assert.equal(result.reason, 'approval_timeout');
  });
});
