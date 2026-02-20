import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContractValidationError,
  buildTriageRequest, validateTriageRequest, validateTriageResponse,
  buildInvestigateRequest, validateInvestigateRequest, validateInvestigateResponse,
  buildSweepRequest, validateSweepRequest, validateSweepResponse,
  buildPlanRequest, validatePlanRequest, validatePlanResponse,
  buildExecuteRequest, validateExecuteRequest, validateExecuteResponse,
  buildVerifyRequest, validateVerifyRequest, validateVerifyResponse
} from '../../../src/a2a/contracts.js';

// ─── Fixtures ───────────────────────────────────────────────

const VALID_TRIAGE_RESPONSE = {
  alert_id: 'alert-001',
  priority_score: 0.85,
  disposition: 'investigate',
  enrichment: {
    correlated_event_count: 12,
    unique_destinations: 3,
    failed_auth_count: 5,
    risk_signal: 0.7,
    historical_fp_rate: 0.15,
    asset_criticality: 'high'
  }
};

const VALID_INVESTIGATE_RESPONSE = {
  investigation_id: 'inv-001',
  incident_id: 'inc-001',
  root_cause: 'Credential stuffing via compromised API key',
  attack_chain: [{ step: 1, description: 'Initial access via API' }],
  blast_radius: ['service-a', 'service-b'],
  recommended_next: 'plan_remediation'
};

const VALID_SWEEP_RESPONSE = {
  incident_id: 'inc-001',
  confirmed_compromised: ['host-a'],
  suspected_compromised: ['host-b'],
  total_assets_scanned: 150,
  clean_assets: 148
};

const VALID_PLAN_RESPONSE = {
  incident_id: 'inc-001',
  remediation_plan: {
    actions: [{
      order: 1,
      action_type: 'disable_user',
      description: 'Disable compromised user account',
      target_system: 'active_directory',
      approval_required: true
    }],
    success_criteria: [{
      metric: 'failed_logins',
      operator: 'lte',
      threshold: 0,
      service_name: 'auth-service'
    }]
  }
};

const VALID_EXECUTE_RESPONSE = {
  incident_id: 'inc-001',
  status: 'completed',
  actions_completed: 3,
  actions_failed: 0,
  action_results: [{ action_type: 'disable_user', success: true }]
};

const VALID_VERIFY_RESPONSE = {
  incident_id: 'inc-001',
  iteration: 1,
  health_score: 0.95,
  passed: true,
  criteria_results: [{ metric: 'failed_logins', met: true }]
};

// ─── Contract 1: Triage ─────────────────────────────────────

describe('Contract 1 — Triage', () => {
  it('buildTriageRequest produces task field', () => {
    const req = buildTriageRequest({
      alert_id: 'a-1', rule_id: 'r-1', severity_original: 'high',
      source_ip: '10.0.0.1', source_user: 'jdoe', affected_asset_id: 'srv-1'
    });
    assert.equal(req.task, 'enrich_and_score');
    assert.equal(req.alert.alert_id, 'a-1');
  });

  it('validates a correct triage response', () => {
    assert.doesNotThrow(() => validateTriageResponse(VALID_TRIAGE_RESPONSE));
  });

  it('rejects missing alert_id', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, alert_id: undefined };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.equal(err.name, 'ContractValidationError');
      assert.equal(err.contract, 'triage_response');
      assert.ok(err.errors.some(e => e.includes('alert_id')));
      return true;
    });
  });

  it('rejects priority_score out of range (above)', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, priority_score: 1.5 };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('priority_score')));
      return true;
    });
  });

  // ── Boundary value tests (R2) ──

  it('rejects priority_score: -0.1 (below range)', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, priority_score: -0.1 };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('priority_score')));
      return true;
    });
  });

  it('accepts priority_score: 0.0 (boundary)', () => {
    const resp = { ...VALID_TRIAGE_RESPONSE, priority_score: 0.0 };
    assert.doesNotThrow(() => validateTriageResponse(resp));
  });

  it('accepts priority_score: 1.0 (boundary)', () => {
    const resp = { ...VALID_TRIAGE_RESPONSE, priority_score: 1.0 };
    assert.doesNotThrow(() => validateTriageResponse(resp));
  });

  // ── Wrong-type tests (R3) ──

  it('rejects alert_id: 123 (number instead of string)', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, alert_id: 123 };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('alert_id') && e.includes('type')));
      return true;
    });
  });

  it('rejects priority_score: "high" (string instead of number)', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, priority_score: 'high' };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('priority_score') && e.includes('type')));
      return true;
    });
  });

  // ── Null response accumulates multiple errors ──

  it('accumulates multiple errors for null-like fields', () => {
    assert.throws(() => validateTriageResponse({}), (err) => {
      assert.ok(err.errors.length >= 4, `Expected at least 4 errors, got ${err.errors.length}`);
      return true;
    });
  });

  it('rejects invalid disposition', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, disposition: 'ignore' };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('disposition')));
      return true;
    });
  });

  it('rejects missing enrichment sub-fields', () => {
    const bad = { ...VALID_TRIAGE_RESPONSE, enrichment: {} };
    assert.throws(() => validateTriageResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('correlated_event_count')));
      assert.ok(err.errors.some(e => e.includes('unique_destinations')));
      assert.ok(err.errors.some(e => e.includes('failed_auth_count')));
      assert.ok(err.errors.some(e => e.includes('risk_signal')));
      assert.ok(err.errors.some(e => e.includes('historical_fp_rate')));
      assert.ok(err.errors.some(e => e.includes('asset_criticality')));
      return true;
    });
  });
});

// ─── Contract 2: Investigator ───────────────────────────────

describe('Contract 2 — Investigator', () => {
  it('buildInvestigateRequest produces task field', () => {
    const req = buildInvestigateRequest('inc-1', 'credential_abuse', { foo: 'bar' });
    assert.equal(req.task, 'investigate');
    assert.equal(req.incident_id, 'inc-1');
    assert.equal(req.incident_type, 'credential_abuse');
  });

  it('includes previous_failure_analysis when provided', () => {
    const req = buildInvestigateRequest('inc-1', 'brute_force', {}, { reason: 'timeout' });
    assert.deepEqual(req.previous_failure_analysis, { reason: 'timeout' });
  });

  it('omits previous_failure_analysis when not provided', () => {
    const req = buildInvestigateRequest('inc-1', 'brute_force', {});
    assert.equal(req.previous_failure_analysis, undefined);
  });

  it('validates a correct investigate response', () => {
    assert.doesNotThrow(() => validateInvestigateResponse(VALID_INVESTIGATE_RESPONSE));
  });

  it('rejects missing root_cause', () => {
    const bad = { ...VALID_INVESTIGATE_RESPONSE, root_cause: undefined };
    assert.throws(() => validateInvestigateResponse(bad), (err) => {
      assert.equal(err.contract, 'investigate_response');
      assert.ok(err.errors.some(e => e.includes('root_cause')));
      return true;
    });
  });

  it('rejects invalid recommended_next', () => {
    const bad = { ...VALID_INVESTIGATE_RESPONSE, recommended_next: 'nuke_from_orbit' };
    assert.throws(() => validateInvestigateResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('recommended_next')));
      return true;
    });
  });

  // ── change_correlation.matched branch (T2) ──

  it('rejects change_correlation.matched as non-boolean', () => {
    const bad = {
      ...VALID_INVESTIGATE_RESPONSE,
      change_correlation: { matched: 'yes' }
    };
    assert.throws(() => validateInvestigateResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('change_correlation.matched')));
      return true;
    });
  });

  it('accepts change_correlation.matched as boolean', () => {
    const resp = {
      ...VALID_INVESTIGATE_RESPONSE,
      change_correlation: { matched: true }
    };
    assert.doesNotThrow(() => validateInvestigateResponse(resp));
  });
});

// ─── Contract 3: Threat Hunter ──────────────────────────────

describe('Contract 3 — Threat Hunter', () => {
  it('buildSweepRequest produces task field', () => {
    const req = buildSweepRequest('inc-1');
    assert.equal(req.task, 'sweep_environment');
    assert.equal(req.incident_id, 'inc-1');
  });

  it('defaults indicators and known_compromised_users', () => {
    const req = buildSweepRequest('inc-1');
    assert.deepEqual(req.indicators, {});
    assert.deepEqual(req.known_compromised_users, []);
  });

  it('validates a correct sweep response', () => {
    assert.doesNotThrow(() => validateSweepResponse(VALID_SWEEP_RESPONSE));
  });

  it('rejects missing total_assets_scanned', () => {
    const bad = { ...VALID_SWEEP_RESPONSE, total_assets_scanned: undefined };
    assert.throws(() => validateSweepResponse(bad), (err) => {
      assert.equal(err.contract, 'sweep_response');
      assert.ok(err.errors.some(e => e.includes('total_assets_scanned')));
      return true;
    });
  });
});

// ─── Contract 4: Commander ──────────────────────────────────

describe('Contract 4 — Commander', () => {
  it('buildPlanRequest produces task field', () => {
    const req = buildPlanRequest('inc-1', 'critical', { summary: 'attack' });
    assert.equal(req.task, 'plan_remediation');
    assert.equal(req.severity, 'critical');
  });

  it('validates a correct plan response with nested structures', () => {
    assert.doesNotThrow(() => validatePlanResponse(VALID_PLAN_RESPONSE));
  });

  it('rejects action missing order', () => {
    const bad = structuredClone(VALID_PLAN_RESPONSE);
    delete bad.remediation_plan.actions[0].order;
    assert.throws(() => validatePlanResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('order')));
      return true;
    });
  });

  it('rejects action missing approval_required boolean', () => {
    const bad = structuredClone(VALID_PLAN_RESPONSE);
    bad.remediation_plan.actions[0].approval_required = 'yes';
    assert.throws(() => validatePlanResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('approval_required')));
      return true;
    });
  });

  it('rejects criterion missing metric', () => {
    const bad = structuredClone(VALID_PLAN_RESPONSE);
    delete bad.remediation_plan.success_criteria[0].metric;
    assert.throws(() => validatePlanResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('metric')));
      return true;
    });
  });

  it('buildPlanRequest includes all passed fields', () => {
    const req = buildPlanRequest(
      'inc-1', 'critical',
      { summary: 'attack' },
      { hosts: ['h1'] },
      ['svc-a', 'svc-b']
    );
    assert.equal(req.task, 'plan_remediation');
    assert.equal(req.incident_id, 'inc-1');
    assert.equal(req.severity, 'critical');
    assert.deepEqual(req.investigation_report, { summary: 'attack' });
    assert.deepEqual(req.threat_scope, { hosts: ['h1'] });
    assert.deepEqual(req.affected_services, ['svc-a', 'svc-b']);
  });
});

// ─── Contract 5: Executor ───────────────────────────────────

describe('Contract 5 — Executor', () => {
  it('buildExecuteRequest produces task field', () => {
    const req = buildExecuteRequest('inc-1', { actions: [] });
    assert.equal(req.task, 'execute_plan');
    assert.equal(req.incident_id, 'inc-1');
  });

  it('validates completed status', () => {
    assert.doesNotThrow(() => validateExecuteResponse(VALID_EXECUTE_RESPONSE));
  });

  it('validates partial_failure status', () => {
    const resp = { ...VALID_EXECUTE_RESPONSE, status: 'partial_failure', actions_failed: 1 };
    assert.doesNotThrow(() => validateExecuteResponse(resp));
  });

  it('rejects invalid status', () => {
    const bad = { ...VALID_EXECUTE_RESPONSE, status: 'unknown' };
    assert.throws(() => validateExecuteResponse(bad), (err) => {
      assert.equal(err.contract, 'execute_response');
      assert.ok(err.errors.some(e => e.includes('status')));
      return true;
    });
  });

  it('rejects missing action_results', () => {
    const bad = { ...VALID_EXECUTE_RESPONSE, action_results: undefined };
    assert.throws(() => validateExecuteResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('action_results')));
      return true;
    });
  });

  // ── Missing branch: failed status (T1) ──

  it('validates failed status', () => {
    const resp = { ...VALID_EXECUTE_RESPONSE, status: 'failed', actions_failed: 3, actions_completed: 0 };
    assert.doesNotThrow(() => validateExecuteResponse(resp));
  });

  // ── Wrong-type test (R3) ──

  it('rejects action_results: "not-an-array" (string instead of array)', () => {
    const bad = { ...VALID_EXECUTE_RESPONSE, action_results: 'not-an-array' };
    assert.throws(() => validateExecuteResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('action_results')));
      return true;
    });
  });
});

// ─── Contract 6: Verifier ───────────────────────────────────

describe('Contract 6 — Verifier', () => {
  it('buildVerifyRequest produces task field', () => {
    const req = buildVerifyRequest('inc-1', ['svc-a'], [{ metric: 'uptime' }]);
    assert.equal(req.task, 'verify_resolution');
    assert.equal(req.incident_id, 'inc-1');
  });

  it('validates passed=true response', () => {
    assert.doesNotThrow(() => validateVerifyResponse(VALID_VERIFY_RESPONSE));
  });

  it('validates passed=false with failure_analysis', () => {
    const resp = {
      ...VALID_VERIFY_RESPONSE,
      passed: false,
      health_score: 0.4,
      failure_analysis: { reason: 'Metrics still degraded' }
    };
    assert.doesNotThrow(() => validateVerifyResponse(resp));
  });

  it('rejects passed=false without failure_analysis', () => {
    const bad = { ...VALID_VERIFY_RESPONSE, passed: false };
    assert.throws(() => validateVerifyResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('failure_analysis')));
      return true;
    });
  });

  it('rejects health_score out of range', () => {
    const bad = { ...VALID_VERIFY_RESPONSE, health_score: 1.5 };
    assert.throws(() => validateVerifyResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('health_score')));
      return true;
    });
  });

  it('rejects missing criteria_results', () => {
    const bad = { ...VALID_VERIFY_RESPONSE, criteria_results: undefined };
    assert.throws(() => validateVerifyResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('criteria_results')));
      return true;
    });
  });

  // ── Boundary value tests (R2) ──

  it('rejects health_score: -0.1 (below range)', () => {
    const bad = { ...VALID_VERIFY_RESPONSE, health_score: -0.1 };
    assert.throws(() => validateVerifyResponse(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('health_score')));
      return true;
    });
  });

  it('accepts health_score: 0.0 (boundary)', () => {
    const resp = {
      ...VALID_VERIFY_RESPONSE,
      passed: false,
      health_score: 0.0,
      failure_analysis: { reason: 'Total failure' }
    };
    assert.doesNotThrow(() => validateVerifyResponse(resp));
  });

  it('accepts health_score: 1.0 (boundary)', () => {
    const resp = { ...VALID_VERIFY_RESPONSE, health_score: 1.0 };
    assert.doesNotThrow(() => validateVerifyResponse(resp));
  });
});

// ─── ContractValidationError shape ──────────────────────────

describe('ContractValidationError', () => {
  it('has contract and errors properties', () => {
    const err = new ContractValidationError('test_contract', ['field is required']);
    assert.equal(err.name, 'ContractValidationError');
    assert.equal(err.contract, 'test_contract');
    assert.deepEqual(err.errors, ['field is required']);
    assert.ok(err.message.includes('test_contract'));
  });

  it('is an instance of Error', () => {
    const err = new ContractValidationError('x', []);
    assert.ok(err instanceof Error);
  });
});

// ─── Request Validation ─────────────────────────────────────

describe('Request validators', () => {
  // ── Triage ──

  it('validateTriageRequest accepts valid request from builder', () => {
    const req = buildTriageRequest({
      alert_id: 'a-1', rule_id: 'r-1', severity_original: 'high',
      source_ip: '10.0.0.1', source_user: 'jdoe', affected_asset_id: 'srv-1'
    });
    assert.doesNotThrow(() => validateTriageRequest(req));
  });

  it('validateTriageRequest rejects missing alert fields', () => {
    const req = { task: 'enrich_and_score', alert: {} };
    assert.throws(() => validateTriageRequest(req), (err) => {
      assert.equal(err.contract, 'triage_request');
      assert.ok(err.errors.some(e => e.includes('alert.alert_id')));
      assert.ok(err.errors.some(e => e.includes('alert.rule_id')));
      return true;
    });
  });

  it('validateTriageRequest rejects wrong task', () => {
    const req = { task: 'wrong_task', alert: { alert_id: 'a-1', rule_id: 'r-1', severity_original: 'high', source_ip: '10.0.0.1', source_user: 'jdoe', affected_asset_id: 'srv-1' } };
    assert.throws(() => validateTriageRequest(req), (err) => {
      assert.ok(err.errors.some(e => e.includes('enrich_and_score')));
      return true;
    });
  });

  // ── Investigate ──

  it('validateInvestigateRequest accepts valid request from builder', () => {
    const req = buildInvestigateRequest('inc-1', 'credential_abuse', { foo: 'bar' });
    assert.doesNotThrow(() => validateInvestigateRequest(req));
  });

  it('validateInvestigateRequest rejects missing incident_id', () => {
    const req = { task: 'investigate' };
    assert.throws(() => validateInvestigateRequest(req), (err) => {
      assert.equal(err.contract, 'investigate_request');
      assert.ok(err.errors.some(e => e.includes('incident_id')));
      return true;
    });
  });

  // ── Sweep ──

  it('validateSweepRequest accepts valid request from builder', () => {
    const req = buildSweepRequest('inc-1', { ips: ['10.0.0.1'] }, ['user-a']);
    assert.doesNotThrow(() => validateSweepRequest(req));
  });

  it('validateSweepRequest rejects missing incident_id', () => {
    const req = { task: 'sweep_environment' };
    assert.throws(() => validateSweepRequest(req), (err) => {
      assert.equal(err.contract, 'sweep_request');
      assert.ok(err.errors.some(e => e.includes('incident_id')));
      return true;
    });
  });

  // ── Plan ──

  it('validatePlanRequest accepts valid request from builder', () => {
    const req = buildPlanRequest('inc-1', 'critical', { summary: 'attack' });
    assert.doesNotThrow(() => validatePlanRequest(req));
  });

  it('validatePlanRequest rejects missing severity and investigation_report', () => {
    const req = { task: 'plan_remediation', incident_id: 'inc-1' };
    assert.throws(() => validatePlanRequest(req), (err) => {
      assert.equal(err.contract, 'plan_request');
      assert.ok(err.errors.some(e => e.includes('severity')));
      assert.ok(err.errors.some(e => e.includes('investigation_report')));
      return true;
    });
  });

  // ── Execute ──

  it('validateExecuteRequest accepts valid request from builder', () => {
    const req = buildExecuteRequest('inc-1', { actions: [] });
    assert.doesNotThrow(() => validateExecuteRequest(req));
  });

  it('validateExecuteRequest rejects missing remediation_plan', () => {
    const req = { task: 'execute_plan', incident_id: 'inc-1' };
    assert.throws(() => validateExecuteRequest(req), (err) => {
      assert.equal(err.contract, 'execute_request');
      assert.ok(err.errors.some(e => e.includes('remediation_plan')));
      return true;
    });
  });

  // ── Verify ──

  it('validateVerifyRequest accepts valid request from builder', () => {
    const req = buildVerifyRequest('inc-1', ['svc-a'], [{ metric: 'uptime' }]);
    assert.doesNotThrow(() => validateVerifyRequest(req));
  });

  it('validateVerifyRequest rejects missing affected_services and success_criteria', () => {
    const req = { task: 'verify_resolution', incident_id: 'inc-1' };
    assert.throws(() => validateVerifyRequest(req), (err) => {
      assert.equal(err.contract, 'verify_request');
      assert.ok(err.errors.some(e => e.includes('affected_services')));
      assert.ok(err.errors.some(e => e.includes('success_criteria')));
      return true;
    });
  });
});
