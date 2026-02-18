// A2A contract builders and validators — pure functions, no dependencies.
// Each contract matches the schemas in docs/14-a2a-protocol.md §8.1–8.6.

export class ContractValidationError extends Error {
  constructor(contract, errors) {
    super(`Contract validation failed [${contract}]: ${errors.join('; ')}`);
    this.name = 'ContractValidationError';
    this.contract = contract;
    this.errors = errors;
  }
}

// --- Helpers ---

function requireField(obj, field, type, errors, label) {
  const value = obj?.[field];
  if (value === undefined || value === null) {
    errors.push(`${label || field} is required`);
    return false;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${label || field} must be an array`);
      return false;
    }
  } else if (typeof value !== type) {
    errors.push(`${label || field} must be of type ${type}, got ${typeof value}`);
    return false;
  }
  return true;
}

function requireRange(value, min, max, label, errors) {
  if (typeof value === 'number' && (value < min || value > max)) {
    errors.push(`${label} must be between ${min} and ${max}, got ${value}`);
  }
}

// ============================================================
// Contract 1: Triage (§8.1)
// ============================================================

export function buildTriageRequest(alert) {
  return {
    task: 'enrich_and_score',
    alert: {
      alert_id: alert.alert_id,
      rule_id: alert.rule_id,
      severity_original: alert.severity_original,
      source_ip: alert.source_ip,
      source_user: alert.source_user,
      affected_asset_id: alert.affected_asset_id
    }
  };
}

export function validateTriageResponse(resp) {
  const errors = [];
  requireField(resp, 'alert_id', 'string', errors);
  requireField(resp, 'priority_score', 'number', errors);
  requireField(resp, 'disposition', 'string', errors);
  requireField(resp, 'enrichment', 'object', errors);

  if (resp.priority_score !== undefined) {
    requireRange(resp.priority_score, 0.0, 1.0, 'priority_score', errors);
  }

  const validDispositions = ['investigate', 'queue', 'suppress'];
  if (resp.disposition && !validDispositions.includes(resp.disposition)) {
    errors.push(`disposition must be one of [${validDispositions.join(', ')}], got '${resp.disposition}'`);
  }

  if (resp.enrichment) {
    requireField(resp.enrichment, 'correlated_event_count', 'number', errors, 'enrichment.correlated_event_count');
    requireField(resp.enrichment, 'unique_destinations', 'number', errors, 'enrichment.unique_destinations');
    requireField(resp.enrichment, 'failed_auth_count', 'number', errors, 'enrichment.failed_auth_count');
    requireField(resp.enrichment, 'risk_signal', 'number', errors, 'enrichment.risk_signal');
    requireField(resp.enrichment, 'historical_fp_rate', 'number', errors, 'enrichment.historical_fp_rate');
    requireField(resp.enrichment, 'asset_criticality', 'string', errors, 'enrichment.asset_criticality');
  }

  if (errors.length > 0) throw new ContractValidationError('triage_response', errors);
  return true;
}

// ============================================================
// Contract 2: Investigator (§8.2)
// ============================================================

export function buildInvestigateRequest(incidentId, incidentType, alertContext, previousFailureAnalysis) {
  const payload = {
    task: 'investigate',
    incident_id: incidentId,
    incident_type: incidentType,
    alert_context: alertContext
  };

  if (previousFailureAnalysis) {
    payload.previous_failure_analysis = previousFailureAnalysis;
  }

  return payload;
}

export function validateInvestigateResponse(resp) {
  const errors = [];
  requireField(resp, 'investigation_id', 'string', errors);
  requireField(resp, 'incident_id', 'string', errors);
  requireField(resp, 'root_cause', 'string', errors);
  requireField(resp, 'attack_chain', 'array', errors);
  requireField(resp, 'blast_radius', 'array', errors);
  requireField(resp, 'recommended_next', 'string', errors);

  const validRecommendations = ['threat_hunt', 'plan_remediation', 'escalate'];
  if (resp.recommended_next && !validRecommendations.includes(resp.recommended_next)) {
    errors.push(`recommended_next must be one of [${validRecommendations.join(', ')}], got '${resp.recommended_next}'`);
  }

  if (resp.change_correlation && typeof resp.change_correlation === 'object') {
    if (resp.change_correlation.matched !== undefined && typeof resp.change_correlation.matched !== 'boolean') {
      errors.push('change_correlation.matched must be a boolean');
    }
  }

  if (errors.length > 0) throw new ContractValidationError('investigate_response', errors);
  return true;
}

// ============================================================
// Contract 3: Threat Hunter (§8.3)
// ============================================================

export function buildSweepRequest(incidentId, indicators, knownCompromisedUsers) {
  return {
    task: 'sweep_environment',
    incident_id: incidentId,
    indicators: indicators || {},
    known_compromised_users: knownCompromisedUsers || []
  };
}

export function validateSweepResponse(resp) {
  const errors = [];
  requireField(resp, 'incident_id', 'string', errors);
  requireField(resp, 'confirmed_compromised', 'array', errors);
  requireField(resp, 'suspected_compromised', 'array', errors);
  requireField(resp, 'total_assets_scanned', 'number', errors);
  requireField(resp, 'clean_assets', 'number', errors);

  if (errors.length > 0) throw new ContractValidationError('sweep_response', errors);
  return true;
}

// ============================================================
// Contract 4: Commander (§8.4)
// ============================================================

export function buildPlanRequest(incidentId, severity, investigationReport, threatScope, affectedServices) {
  return {
    task: 'plan_remediation',
    incident_id: incidentId,
    severity,
    investigation_report: investigationReport,
    threat_scope: threatScope || null,
    affected_services: affectedServices || []
  };
}

export function validatePlanResponse(resp) {
  const errors = [];
  requireField(resp, 'incident_id', 'string', errors);
  requireField(resp, 'remediation_plan', 'object', errors);

  if (resp.remediation_plan) {
    requireField(resp.remediation_plan, 'actions', 'array', errors, 'remediation_plan.actions');
    requireField(resp.remediation_plan, 'success_criteria', 'array', errors, 'remediation_plan.success_criteria');

    if (Array.isArray(resp.remediation_plan.actions)) {
      for (let i = 0; i < resp.remediation_plan.actions.length; i++) {
        const action = resp.remediation_plan.actions[i];
        const prefix = `actions[${i}]`;
        if (typeof action.order !== 'number') errors.push(`${prefix}.order must be a number`);
        if (!action.action_type) errors.push(`${prefix}.action_type is required`);
        if (!action.description) errors.push(`${prefix}.description is required`);
        if (!action.target_system && action.target_system !== null) errors.push(`${prefix}.target_system is required`);
        if (typeof action.approval_required !== 'boolean') errors.push(`${prefix}.approval_required must be a boolean`);
      }
    }

    if (Array.isArray(resp.remediation_plan.success_criteria)) {
      for (let i = 0; i < resp.remediation_plan.success_criteria.length; i++) {
        const criterion = resp.remediation_plan.success_criteria[i];
        const prefix = `success_criteria[${i}]`;
        if (!criterion.metric) errors.push(`${prefix}.metric is required`);
        if (!criterion.operator) errors.push(`${prefix}.operator is required`);
        if (criterion.threshold === undefined || criterion.threshold === null) errors.push(`${prefix}.threshold is required`);
        if (!criterion.service_name) errors.push(`${prefix}.service_name is required`);
      }
    }
  }

  if (errors.length > 0) throw new ContractValidationError('plan_response', errors);
  return true;
}

// ============================================================
// Contract 5: Executor (§8.5)
// ============================================================

export function buildExecuteRequest(incidentId, remediationPlan) {
  return {
    task: 'execute_plan',
    incident_id: incidentId,
    remediation_plan: remediationPlan
  };
}

export function validateExecuteResponse(resp) {
  const errors = [];
  requireField(resp, 'incident_id', 'string', errors);
  requireField(resp, 'status', 'string', errors);
  requireField(resp, 'actions_completed', 'number', errors);
  requireField(resp, 'actions_failed', 'number', errors);
  requireField(resp, 'action_results', 'array', errors);

  const validStatuses = ['completed', 'partial_failure', 'failed'];
  if (resp.status && !validStatuses.includes(resp.status)) {
    errors.push(`status must be one of [${validStatuses.join(', ')}], got '${resp.status}'`);
  }

  if (errors.length > 0) throw new ContractValidationError('execute_response', errors);
  return true;
}

// ============================================================
// Contract 6: Verifier (§8.6)
// ============================================================

export function buildVerifyRequest(incidentId, affectedServices, successCriteria) {
  return {
    task: 'verify_resolution',
    incident_id: incidentId,
    affected_services: affectedServices,
    success_criteria: successCriteria
  };
}

export function validateVerifyResponse(resp) {
  const errors = [];
  requireField(resp, 'incident_id', 'string', errors);
  requireField(resp, 'iteration', 'number', errors);
  requireField(resp, 'health_score', 'number', errors);
  requireField(resp, 'passed', 'boolean', errors);
  requireField(resp, 'criteria_results', 'array', errors);

  if (resp.health_score !== undefined) {
    requireRange(resp.health_score, 0.0, 1.0, 'health_score', errors);
  }

  if (!resp.passed && !resp.failure_analysis) {
    errors.push('failure_analysis is required when passed is false');
  }

  if (errors.length > 0) throw new ContractValidationError('verify_response', errors);
  return true;
}
