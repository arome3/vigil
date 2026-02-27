// Plan Builder — pure-function module that constructs remediation plans.
// No I/O except logging. Follows the pattern of src/agents/threat-hunter/scope-report.js.
// Transforms investigation context, runbook matches, and impact data into ordered,
// approval-tagged remediation plans per §4.6 / §8.4.

import { createLogger } from '../../utils/logger.js';

const log = createLogger('commander-plan-builder');

// --- Constants ---

/** Action type execution order: stop the bleeding → fix → inform → record. */
const ACTION_TYPE_ORDER = {
  containment: 1,
  remediation: 2,
  communication: 3,
  documentation: 4
};

/** Estimated duration per action type (minutes). */
const ACTION_DURATION_MINUTES = {
  containment: 5,
  remediation: 15,
  communication: 2,
  documentation: 3
};

/** High-traffic threshold (active requests in 5-min window). */
const HIGH_TRAFFIC_THRESHOLD = 1000;

/**
 * Conservative latency targets by service category (microseconds).
 * Used when no impact data or baseline is available.
 */
const DEFAULT_LATENCY_TARGETS = {
  gateway: 150_000,     // 150ms — API gateways should be fast
  database: 50_000,     // 50ms — DB calls should be tight
  default: 200_000      // 200ms — general service target
};

// --- Action Classification ---

/**
 * Priority-ordered classification patterns. More specific patterns are checked
 * first so that "Update WAF block list" matches remediation ("update") before
 * containment ("block"). Each entry: [regex, action_type].
 */
const CLASSIFICATION_PATTERNS = [
  // Communication — most distinctive keywords, check first
  [/\b(notify|slack|email|pagerduty|page\b|announce|status.?page)\b/i, 'communication'],
  // Documentation — audit/tracking keywords
  [/\b(document|jira|ticket|audit|postmortem|create.+issue|create.+ticket)\b/i, 'documentation'],
  // Containment — dangerous/isolation actions (narrow patterns to avoid false matches)
  [/\b(isolat[ei]|quarantin[ei]|network.+block|firewall.+block|terminat[ei].+session|revok[ei].+access|suspend.+account|disable.+account)\b/i, 'containment'],
  // Everything else → remediation (default)
];

/**
 * Maps runbook step semantics to action types using priority-ordered patterns.
 * More specific patterns win over broad ones. Falls back to 'remediation'.
 */
function classifyActionType(step) {
  const text = ((step.description || '') + ' ' + (step.command || '')).toLowerCase();

  for (const [pattern, actionType] of CLASSIFICATION_PATTERNS) {
    if (pattern.test(text)) return actionType;
  }

  return 'remediation';
}

// --- Approval Logic ---

/**
 * Deterministic approval tagging per §4.6 system prompt rules.
 * Returns true if the action requires human approval before execution.
 *
 * Rules:
 * 1. Network isolation of any asset
 * 2. Production deployment rollback
 * 3. Suspension of privileged user accounts
 * 4. Any action on tier-1 critical assets when severity=critical
 *
 * Also respects runbook step's own approval_required flag.
 *
 * @param {object} action
 * @param {string} severity
 * @param {Set<string>} tier1Assets - Dynamically loaded tier-1 asset IDs
 */
function needsApproval(action, severity, tier1Assets) {
  const desc = (action.description || '').toLowerCase();
  const type = action.action_type || '';
  const targetSystem = (action.target_system || '').toLowerCase();
  const targetAsset = (action.target_asset || '').toLowerCase();

  // Rule 1: Network containment (isolation or firewall blocking)
  if (type === 'containment' && (/\bisolat/.test(desc) || targetSystem === 'firewall')) return true;

  // Rule 2: Production deployment rollback
  if (type === 'remediation' && /\brollback\b/.test(desc) && targetSystem === 'kubernetes') return true;

  // Rule 3: Suspension of privileged user accounts
  if (/\bsuspend\b/.test(desc) && targetSystem === 'okta') return true;

  // Rule 4: Tier-1 critical assets when severity=critical
  if (severity === 'critical' && targetAsset && tier1Assets.has(targetAsset)) return true;

  // Respect runbook step's own flag
  if (action._runbook_approval_required) return true;

  return false;
}

// --- Runbook-Based Action Building ---

/**
 * Transform runbook steps into plan actions.
 * Filters out informational ES|QL steps, enriches with change correlation data,
 * and adapts strategy based on current impact.
 */
function buildActionsFromRunbook(runbook, envelope, impactData) {
  const actions = [];
  const steps = runbook.steps || [];
  const correlation = envelope.investigation_report?.change_correlation;

  for (const step of steps) {
    const command = (step.command || '').toLowerCase();

    // Skip ES|QL informational/diagnostic steps — these are for investigation, not remediation
    if (command.startsWith('vigil-esql-')) continue;

    const actionType = classifyActionType(step);
    let description = step.description || step.name || 'Execute runbook step';

    // Enrich rollback descriptions with change correlation data
    if (correlation?.matched && /\brollback\b/i.test(description)) {
      const sha = correlation.commit_sha || correlation.sha || 'unknown';
      const pr = correlation.pr_number || correlation.pull_request;
      const author = correlation.author;
      const parts = [`commit ${sha}`];
      if (pr) parts.push(`PR #${pr}`);
      if (author) parts.push(`author: ${author}`);
      description += ` (targeting ${parts.join(', ')})`;
    }

    // Adapt restart strategy based on traffic impact
    if (/\brestart\b/i.test(description) && impactData) {
      const targetService = step.target_service || step.target_asset;
      const metrics = impactData.get(targetService);
      if (metrics && metrics.active_requests > HIGH_TRAFFIC_THRESHOLD) {
        description = description.replace(/\brestart\b/i, 'rolling restart');
      }
    }

    actions.push({
      action_type: actionType,
      description,
      target_system: step.target_system || step.system || null,
      target_asset: step.target_asset || step.target_service || null,
      rollback_steps: step.rollback_command ? [step.rollback_command] : undefined,
      _runbook_approval_required: step.approval_required || false,
      _source_runbook: runbook.runbook_id || runbook.title
    });
  }

  return actions;
}

/**
 * Merge remediation-type actions from multiple ranked runbooks.
 * Takes all steps from the top runbook, then fills in from lower-ranked runbooks
 * for action types not already covered. Prevents duplicated remediation.
 *
 * @param {object[]} runbooks - Ranked runbook search results
 * @param {object} envelope
 * @param {Map|null} impactData
 * @returns {object[]} Merged actions (remediation type only)
 */
function mergeRunbookRemediationActions(runbooks, envelope, impactData) {
  if (!runbooks?.length) return [];

  const merged = [];
  const coveredTargets = new Set();

  for (const runbook of runbooks) {
    const actions = buildActionsFromRunbook(runbook, envelope, impactData);

    for (const action of actions) {
      if (action.action_type !== 'remediation') continue;

      const targetKey = `${action.target_system || 'null'}::${action.target_asset || 'null'}`;
      if (coveredTargets.has(targetKey)) continue;

      coveredTargets.add(targetKey);
      merged.push(action);
    }
  }

  return merged;
}

// --- Security Incident Actions ---

/**
 * Build actions for security incidents.
 * Containment → credential remediation → communication → documentation.
 */
function buildSecurityActions(envelope, matchedRunbooks, impactData) {
  const actions = [];
  const report = envelope.investigation_report || {};
  const threatScope = envelope.threat_scope;

  // --- Containment: IP blocking from threat intel ---
  const confirmedAssets = threatScope?.confirmed_compromised || [];
  const ipsToBlock = new Set();

  const threatIntel = report.threat_intel_matches || [];
  for (const match of threatIntel) {
    if (match.ioc_value && isValidIPv4(match.ioc_value)) {
      ipsToBlock.add(match.ioc_value);
    }
  }

  if (ipsToBlock.size > 0) {
    actions.push({
      action_type: 'containment',
      description: `Block malicious IPs at firewall: ${[...ipsToBlock].join(', ')}`,
      target_system: 'firewall',
      target_asset: null
    });
  }

  // --- Containment: Host isolation ---
  for (const asset of confirmedAssets) {
    if (asset.host && /^[a-zA-Z]/.test(asset.host)) {
      actions.push({
        action_type: 'containment',
        description: `Isolate compromised host: ${asset.host}`,
        target_system: 'network',
        target_asset: asset.asset_id || asset.host
      });
    }
  }

  // --- Containment: Session termination and account suspension ---
  const compromisedUsers = new Set();
  const suspectedUsers = threatScope?.suspected_compromised || [];

  for (const suspect of [...confirmedAssets, ...suspectedUsers]) {
    const user = suspect.user || suspect.host;
    if (user && suspect.anomaly_score !== undefined) {
      compromisedUsers.add(user);
    }
  }

  if (compromisedUsers.size > 0) {
    actions.push({
      action_type: 'containment',
      description: `Terminate active sessions for compromised accounts: ${[...compromisedUsers].join(', ')}`,
      target_system: 'okta',
      target_asset: null
    });
    actions.push({
      action_type: 'containment',
      description: `Suspend compromised user accounts pending investigation: ${[...compromisedUsers].join(', ')}`,
      target_system: 'okta',
      target_asset: null
    });
  }

  // --- Remediation: Merge from all matched runbooks ---
  if (matchedRunbooks?.length > 0) {
    const runbookActions = mergeRunbookRemediationActions(matchedRunbooks, envelope, impactData);
    actions.push(...runbookActions);
  }

  if (!matchedRunbooks?.length || !actions.some(a => a.action_type === 'remediation')) {
    // No runbook or no remediation steps found — synthesize default
    actions.push({
      action_type: 'remediation',
      description: 'Rotate all credentials and API keys for affected services',
      target_system: 'vault',
      target_asset: null
    });
  }

  // --- Communication ---
  actions.push({
    action_type: 'communication',
    description: `Post security incident notification to #vigil-incidents with severity ${envelope.severity}, affected assets: ${confirmedAssets.length} confirmed, ${suspectedUsers.length} suspected`,
    target_system: 'slack',
    target_asset: null
  });

  // --- Documentation ---
  actions.push({
    action_type: 'documentation',
    description: `Create Jira ticket for incident ${envelope.incident_id}: ${report.root_cause || 'Security incident requiring investigation'}`,
    target_system: 'jira',
    target_asset: null
  });

  return actions;
}

// --- Operational Incident Actions ---

/**
 * Build actions for operational incidents.
 * Change-correlation rollback or pod restart → scaling → communication → documentation.
 */
function buildOperationalActions(envelope, matchedRunbooks, impactData) {
  const actions = [];
  const report = envelope.investigation_report || {};
  const correlation = report.change_correlation;

  if (matchedRunbooks?.length > 0) {
    // Merge containment + remediation actions from ranked runbooks
    const runbookActions = [];
    for (const runbook of matchedRunbooks) {
      runbookActions.push(...buildActionsFromRunbook(runbook, envelope, impactData));
    }

    // Deduplicate by target before adding
    const seen = new Set();
    for (const action of runbookActions) {
      if (action.action_type !== 'containment' && action.action_type !== 'remediation') continue;
      const key = `${action.target_system || 'null'}::${action.target_asset || 'null'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push(action);
    }
  } else if (correlation?.matched) {
    // Change correlation: target specific commit for rollback
    const sha = correlation.commit_sha || correlation.sha || 'unknown';
    const pr = correlation.pr_number || correlation.pull_request;
    const author = correlation.author;
    const parts = [`commit ${sha}`];
    if (pr) parts.push(`PR #${pr}`);
    if (author) parts.push(`author: ${author}`);

    actions.push({
      action_type: 'remediation',
      description: `Rollback production deployment to pre-change state (targeting ${parts.join(', ')})`,
      target_system: 'kubernetes',
      target_asset: null,
      rollback_steps: [`kubectl rollout undo deployment --to-revision targeting ${sha}`]
    });
  } else {
    // No correlation, no runbook — restart affected pods
    const affectedServices = envelope.affected_services || [];
    for (const service of affectedServices) {
      const metrics = impactData?.get(service);
      const isHighTraffic = metrics && metrics.active_requests > HIGH_TRAFFIC_THRESHOLD;
      const restartType = isHighTraffic ? 'rolling restart' : 'restart';

      actions.push({
        action_type: 'remediation',
        description: `Perform ${restartType} of ${service} pods`,
        target_system: 'kubernetes',
        target_asset: service
      });
    }
  }

  // Scale downstream services if impact data shows strain
  if (impactData) {
    for (const [serviceName, metrics] of impactData) {
      if (metrics.error_rate > 10 && !envelope.affected_services?.includes(serviceName)) {
        actions.push({
          action_type: 'remediation',
          description: `Scale up ${serviceName} to handle cascading load (current error rate: ${metrics.error_rate.toFixed(1)}%)`,
          target_system: 'kubernetes',
          target_asset: serviceName
        });
      }
    }
  }

  // --- Communication ---
  actions.push({
    action_type: 'communication',
    description: `Post operational incident notification to #vigil-incidents: ${report.root_cause || 'Service degradation detected'}`,
    target_system: 'slack',
    target_asset: null
  });

  // --- Documentation ---
  actions.push({
    action_type: 'documentation',
    description: `Create Jira ticket for incident ${envelope.incident_id}: ${report.root_cause || 'Operational incident'}`,
    target_system: 'jira',
    target_asset: null
  });

  return actions;
}

// --- Action Ordering ---

/**
 * Sort actions by type priority (containment → remediation → communication → documentation)
 * and assign sequential 1-based order numbers.
 * Returns a new array — does not mutate the input.
 */
function orderActions(actions) {
  return [...actions]
    .sort((a, b) => {
      const orderA = ACTION_TYPE_ORDER[a.action_type] ?? 99;
      const orderB = ACTION_TYPE_ORDER[b.action_type] ?? 99;
      return orderA - orderB;
    })
    .map((action, i) => ({
      ...action,
      order: i + 1
    }));
}

// --- Deduplication ---

/**
 * Remove duplicate actions (same action_type + target_system + target_asset + action verb).
 * Uses the first word of the description as an action verb discriminator so that
 * semantically different actions on the same system (e.g. "Terminate sessions" vs
 * "Suspend accounts") are preserved. Keeps the first occurrence.
 */
function deduplicateActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    const verb = (action.description || '').split(/\s/)[0].toLowerCase();
    const key = `${action.action_type}::${action.target_asset || 'null'}::${action.target_system || 'null'}::${verb}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Success Criteria ---

/**
 * Derive a latency target for a service. Uses current degraded latency as a
 * ceiling and applies a recovery factor, but never sets a target below a
 * reasonable floor or above a generous ceiling.
 *
 * @param {string} serviceName
 * @param {object|undefined} metrics - Current impact metrics
 * @returns {number} Target latency in microseconds
 */
function deriveLatencyTarget(serviceName, metrics) {
  const RECOVERY_FACTOR = 0.3;    // Target 30% of current degraded latency
  const MIN_LATENCY = 10_000;     // 10ms floor — no service is this fast in practice
  const MAX_LATENCY = 500_000;    // 500ms ceiling — anything above is already a problem

  // Pick a category-based default
  let defaultTarget = DEFAULT_LATENCY_TARGETS.default;
  const nameLower = serviceName.toLowerCase();
  if (nameLower.includes('gateway') || nameLower.includes('proxy')) {
    defaultTarget = DEFAULT_LATENCY_TARGETS.gateway;
  } else if (nameLower.includes('database') || nameLower.includes('db') || nameLower.includes('postgres') || nameLower.includes('redis')) {
    defaultTarget = DEFAULT_LATENCY_TARGETS.database;
  }

  if (!metrics?.avg_latency || metrics.avg_latency <= 0) {
    return defaultTarget;
  }

  // If current latency is already at or below the default target the service
  // is healthy (or recovering).  Use the default — don't set an impossibly
  // tight threshold that would cause the verifier to fail a healthy service.
  if (metrics.avg_latency <= defaultTarget) {
    return defaultTarget;
  }

  // Service is degraded — use a fraction of degraded latency as recovery target
  const derived = Math.round(metrics.avg_latency * RECOVERY_FACTOR);
  return Math.max(MIN_LATENCY, Math.min(MAX_LATENCY, derived));
}

/**
 * Build verification criteria for each affected service.
 * These are checked by vigil-verifier after plan execution.
 */
function buildSuccessCriteria(envelope, impactData) {
  const services = envelope.affected_services || [];
  const criteria = [];

  for (const service of services) {
    const metrics = impactData?.get(service);

    // Error rate should drop below 1%
    criteria.push({
      metric: 'error_rate',
      operator: 'lte',
      threshold: 1.0,
      service_name: service
    });

    // Latency should return to a healthy range
    criteria.push({
      metric: 'avg_latency',
      operator: 'lte',
      threshold: deriveLatencyTarget(service, metrics),
      service_name: service
    });

    // Throughput should be viable
    criteria.push({
      metric: 'throughput',
      operator: 'gte',
      threshold: 80,
      service_name: service
    });
  }

  return criteria;
}

// --- Incident Type Detection ---

/**
 * Detect whether an incident is security or operational based on investigation_report shape.
 * Security if threat_scope is non-null, or attack_chain/threat_intel_matches are present.
 */
function detectIncidentType(envelope) {
  if (envelope.threat_scope) return 'security';

  const report = envelope.investigation_report || {};

  if (report.attack_chain?.length > 0) return 'security';
  if (report.threat_intel_matches?.length > 0) return 'security';

  return 'operational';
}

// --- IP Validation ---

/**
 * Validate an IPv4 address string. Checks each octet is 0–255.
 */
function isValidIPv4(str) {
  if (!str || typeof str !== 'string') return false;
  const parts = str.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 && p === String(n);
  });
}

// --- Main Exports ---

/**
 * Build a complete remediation plan from investigation context, runbook matches,
 * and impact assessment data.
 *
 * @param {object} envelope - Request envelope from buildPlanRequest()
 * @param {object[]|null} matchedRunbooks - Ranked runbook search results
 * @param {Map<string, object>|null} impactAssessments - Service → {active_requests, avg_latency, error_rate}
 * @param {Set<string>} [tier1Assets] - Dynamically loaded tier-1 asset IDs
 * @returns {object} Response matching §8.4 contract (validated by validatePlanResponse)
 */
export function buildRemediationPlan(envelope, matchedRunbooks, impactAssessments, tier1Assets) {
  // Fallback tier-1 set if not provided (keeps the function testable without handler)
  const effectiveTier1 = tier1Assets || new Set([
    'api-gateway', 'auth-service', 'payment-service',
    'database-primary', 'load-balancer', 'dns-primary'
  ]);

  const incidentType = detectIncidentType(envelope);
  log.info(`Building ${incidentType} remediation plan for ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    incident_type: incidentType,
    runbooks_available: matchedRunbooks?.length || 0,
    impact_services: impactAssessments?.size || 0
  });

  // 1. Build type-specific actions
  let actions;
  if (incidentType === 'security') {
    actions = buildSecurityActions(envelope, matchedRunbooks, impactAssessments);
  } else {
    actions = buildOperationalActions(envelope, matchedRunbooks, impactAssessments);
  }

  // 2. Deduplicate (same target_asset + action_type + verb)
  actions = deduplicateActions(actions);

  // 3. Order by type priority and assign sequence numbers (non-mutating)
  actions = orderActions(actions);

  // 4. Tag approvals (must happen after ordering so descriptions are final)
  actions = actions.map(action => {
    const approvalRequired = needsApproval(action, envelope.severity, effectiveTier1);
    // Clean up internal-only fields
    const { _runbook_approval_required, _source_runbook, ...cleanAction } = action;
    return {
      ...cleanAction,
      approval_required: approvalRequired
    };
  });

  // 5. Build success criteria
  const successCriteria = buildSuccessCriteria(envelope, impactAssessments);

  // 6. Compute estimated duration
  const estimatedMinutes = actions.reduce((sum, action) => {
    return sum + (ACTION_DURATION_MINUTES[action.action_type] || 5);
  }, 0);

  // 7. Determine if any action requires approval
  const requiresApproval = actions.some(a => a.approval_required);

  log.info(`Plan complete for ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    action_count: actions.length,
    criteria_count: successCriteria.length,
    estimated_minutes: estimatedMinutes,
    requires_approval: requiresApproval,
    runbook_used: matchedRunbooks?.[0]?.runbook_id || null
  });

  return {
    incident_id: envelope.incident_id,
    remediation_plan: {
      actions,
      success_criteria: successCriteria,
      estimated_duration_minutes: estimatedMinutes,
      requires_approval: requiresApproval,
      runbook_used: matchedRunbooks?.[0]?.runbook_id || null
    }
  };
}

/**
 * Build a minimal valid plan for total failure scenarios.
 * Contains a single escalation notification action so the pipeline doesn't stall.
 *
 * @param {string} incidentId
 * @param {string} severity
 * @param {string} errorMessage
 * @returns {object} Minimal valid response matching §8.4
 */
export function buildFallbackPlan(incidentId, severity, errorMessage) {
  log.warn(`Building fallback plan for ${incidentId}: ${errorMessage}`, {
    incident_id: incidentId,
    severity,
    reason: errorMessage
  });

  return {
    incident_id: incidentId,
    remediation_plan: {
      actions: [
        {
          order: 1,
          action_type: 'communication',
          description: `ESCALATION: Automated planning failed (${errorMessage}). Manual remediation required for incident ${incidentId} (severity: ${severity}).`,
          target_system: 'slack',
          target_asset: null,
          approval_required: false
        }
      ],
      success_criteria: [],
      estimated_duration_minutes: 0,
      requires_approval: false,
      runbook_used: null
    }
  };
}
