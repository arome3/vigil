import { v4 as uuidv4 } from 'uuid';
import { transitionIncident, getIncident } from '../../state-machine/transitions.js';
import { evaluateGuard } from '../../state-machine/guards.js';
import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';
import {
  buildInvestigateRequest, validateInvestigateResponse,
  buildSweepRequest, validateSweepResponse,
  buildPlanRequest, validatePlanResponse,
  buildExecuteRequest, validateExecuteResponse,
  buildVerifyRequest, validateVerifyResponse
} from '../../a2a/contracts.js';
import { escalateIncident, checkConflictingAssessments, checkApprovalTimeout } from './escalation.js';
import { computeTimingMetrics } from './timing.js';
import { incrementRunbookUsage } from '../analyst/runbook-generator.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { parseThreshold, parsePositiveInt } from '../../utils/env.js';

const log = createLogger('coordinator-delegation');

// --- Runbook usage tracking ---

/**
 * Update runbook usage stats after an incident outcome is known.
 * Non-critical — failures are logged but never block the pipeline.
 */
async function trackRunbookOutcome(remediationPlan, wasSuccessful) {
  const runbookId = remediationPlan?.runbook_used;
  if (!runbookId) return;
  try {
    await incrementRunbookUsage(runbookId, wasSuccessful);
    log.info(`Tracked runbook ${runbookId} outcome: ${wasSuccessful ? 'success' : 'failure'}`);
  } catch (err) {
    log.warn(`Failed to track runbook usage for ${runbookId}: ${err.message}`);
  }
}

const SUPPRESS_THRESHOLD = parseThreshold('VIGIL_TRIAGE_SUPPRESS_THRESHOLD', 0.4);
const APPROVAL_TIMEOUT_MINUTES = parsePositiveInt('VIGIL_APPROVAL_TIMEOUT_MINUTES', 15);
const MAX_REFLECTION_LOOPS = parsePositiveInt('VIGIL_MAX_REFLECTION_LOOPS', 3);
const APPROVAL_POLL_INTERVAL_MS = 15_000; // 15 seconds

// --- Helpers ---

function generateIncidentId() {
  const year = new Date().getFullYear();
  const slug = uuidv4().slice(0, 5).toUpperCase();
  return `INC-${year}-${slug}`;
}

async function createIncidentDocument(incidentId, triageResponse, incidentType, alertTimestamp) {
  const now = new Date().toISOString();
  const doc = {
    incident_id: incidentId,
    status: 'detected',
    incident_type: incidentType,
    severity: triageResponse.enrichment?.asset_criticality === 'tier-1' ? 'critical' : 'high',
    priority_score: triageResponse.priority_score,
    alert_ids: [triageResponse.alert_id],
    alert_timestamp: alertTimestamp || triageResponse.alert_timestamp || now,
    affected_services: [],
    affected_assets: [],
    investigation_summary: null,
    remediation_plan: null,
    verification_results: [],
    reflection_count: 0,
    escalation_triggered: false,
    resolution_type: null,
    resolved_at: null,
    created_at: now,
    updated_at: now,
    _state_timestamps: { detected: now }
  };

  await client.index({
    index: 'vigil-incidents',
    id: incidentId,
    document: doc,
    refresh: 'wait_for'
  });

  log.info(`Created incident ${incidentId} (type: ${incidentType})`);
  return doc;
}

async function delegateToAgent(agentId, incidentId, payload) {
  const envelope = createEnvelope('vigil-coordinator', agentId, incidentId, payload);
  return sendA2AMessage(agentId, envelope);
}

async function updateIncidentFields(incidentId, fields) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { _seq_no, _primary_term } = await getIncident(incidentId);
    try {
      await client.update({
        index: 'vigil-incidents',
        id: incidentId,
        if_seq_no: _seq_no,
        if_primary_term: _primary_term,
        doc: { ...fields, updated_at: new Date().toISOString() },
        refresh: 'wait_for'
      });
      return;
    } catch (err) {
      if (err.meta?.statusCode === 409 && attempt < MAX_RETRIES) {
        log.warn(`Conflict updating incident ${incidentId}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function extractAffectedServices(investigatorResp, threatHunterResp) {
  const services = new Set();
  for (const asset of (investigatorResp?.blast_radius || [])) {
    if (asset.asset_id) services.add(asset.asset_id);
  }
  for (const asset of (threatHunterResp?.confirmed_compromised || [])) {
    if (asset.asset_id) services.add(asset.asset_id);
  }
  return [...services];
}

function extractIndicators(investigatorResp) {
  const indicators = { ips: [], domains: [], hashes: [], processes: [] };
  if (!investigatorResp) return indicators;

  // Pull IoCs from attack chain evidence and threat intel matches
  for (const match of (investigatorResp.threat_intel_matches || [])) {
    if (match.ioc_value) {
      // Simple heuristic: IP-like values go to ips, rest to domains
      if (/^\d+\.\d+\.\d+\.\d+/.test(match.ioc_value)) {
        indicators.ips.push(match.ioc_value);
      } else {
        indicators.domains.push(match.ioc_value);
      }
    }
  }

  return indicators;
}

function extractCompromisedUsers(alertContext) {
  // Extract the source user from the alert context the Coordinator built.
  // Note: the Investigator's *response* does not echo back alert_context —
  // it only exists on the request envelope. The Coordinator must pass its
  // own alertContext here, not the investigatorResp.
  const users = [];
  if (alertContext?.source_user && alertContext.source_user !== 'unknown') {
    users.push(alertContext.source_user);
  }
  return users;
}

// --- Approval Gate ---

async function waitForApproval(incidentId) {
  // Trigger the approval workflow
  const approvalPayload = {
    task: 'request_approval',
    incident_id: incidentId,
    channel: 'slack'
  };

  try {
    await delegateToAgent('vigil-wf-approval', incidentId, approvalPayload);
  } catch (err) {
    log.error(`Failed to trigger approval workflow for ${incidentId}: ${err.message}`);
    throw err;
  }

  const approvalStartTime = new Date().toISOString();
  const timeoutMs = APPROVAL_TIMEOUT_MINUTES * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  // Poll for approval status
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));

    const { doc } = await getIncident(incidentId);

    if (doc.approval_status === 'approved') {
      log.info(`Approval granted for ${incidentId}`);
      return 'approved';
    }

    if (doc.approval_status === 'rejected') {
      log.info(`Approval rejected for ${incidentId}`);
      return 'rejected';
    }
  }

  log.warn(`Approval timeout for ${incidentId} after ${APPROVAL_TIMEOUT_MINUTES} minutes`);
  return 'timeout';
}

// ============================================================
// Security Flow
// ============================================================

export async function orchestrateSecurityIncident(triageResponse, rawAlert = {}) {
  const incidentId = generateIncidentId();
  log.info(`Starting security incident orchestration: ${incidentId}`);

  // Extract alert timestamp from raw alert for accurate timing metrics
  const alertTimestamp = rawAlert['@timestamp'] || rawAlert.timestamp;

  // Create incident and transition to triaged (common to both paths)
  await createIncidentDocument(incidentId, triageResponse, 'security', alertTimestamp);
  await transitionIncident(incidentId, 'triaged');

  // Evaluate suppress guard against the triaged document
  const { doc: triagedDoc } = await getIncident(incidentId);
  const suppressGuard = evaluateGuard(triagedDoc, 'triaged', 'suppressed');

  if (suppressGuard.allowed) {
    await transitionIncident(incidentId, 'suppressed', {
      suppression_reason: triageResponse.suppression_reason || 'Priority score below threshold'
    });
    log.info(`Incident ${incidentId} suppressed (priority_score: ${triageResponse.priority_score})`);
    return { incidentId, status: 'suppressed' };
  }

  // Investigate path
  await transitionIncident(incidentId, 'investigating');

  // Extract real context from raw alert (nested ECS fields with flat fallbacks)
  const sourceIp = rawAlert.source?.ip || rawAlert.source_ip || '';
  const destIp = rawAlert.destination?.ip || rawAlert.destination_ip || '';
  const sourceUser = rawAlert.source?.user_name || rawAlert.user?.name || rawAlert.source_user || '';
  const assetId = rawAlert.affected_asset?.id || rawAlert.affected_asset_id || '';
  const assetName = rawAlert.affected_asset?.name || assetId;

  // Build alert context for investigator using raw alert data
  const alertContext = {
    alert_ids: [triageResponse.alert_id],
    source_ip: sourceIp || 'unknown',
    source_user: sourceUser || 'unknown',
    affected_assets: assetName ? [assetName] : [],
    severity: triageResponse.priority_score >= 0.7 ? 'high' : 'medium',
    initial_indicators: {
      ips: [...new Set([sourceIp, destIp].filter(Boolean))],
      hashes: [],
      domains: []
    }
  };

  // --- Investigate ---
  let investigatorResp;
  try {
    const investigatePayload = buildInvestigateRequest(incidentId, 'security', alertContext);
    investigatorResp = await delegateToAgent('vigil-investigator', incidentId, investigatePayload);
    validateInvestigateResponse(investigatorResp);
  } catch (err) {
    log.error(`Investigation failed for ${incidentId}: ${err.message}`);
    await transitionIncident(incidentId, 'planning');
    await transitionIncident(incidentId, 'escalated');
    const { doc } = await getIncident(incidentId);
    await escalateIncident(doc, `Investigation failed: ${err.message}`, {
      root_cause: 'Investigation agent error'
    });
    return { incidentId, status: 'escalated', reason: 'investigation_failed' };
  }

  // Store investigation summary with completion timestamp for TTI metric
  await updateIncidentFields(incidentId, {
    investigation_summary: investigatorResp.root_cause,
    investigation_report: investigatorResp,
    _investigation_completed_at: new Date().toISOString()
  });

  // --- Threat Hunt (if security + recommended) ---
  let threatHunterResp = null;
  if (investigatorResp.recommended_next === 'threat_hunt') {
    await transitionIncident(incidentId, 'threat_hunting');

    try {
      const indicators = extractIndicators(investigatorResp);
      const compromisedUsers = extractCompromisedUsers(alertContext);
      const sweepPayload = buildSweepRequest(incidentId, indicators, compromisedUsers);
      threatHunterResp = await delegateToAgent('vigil-threat-hunter', incidentId, sweepPayload);
      validateSweepResponse(threatHunterResp);
    } catch (err) {
      log.error(`Threat hunting failed for ${incidentId}: ${err.message}`);
      // Continue to planning even if threat hunt fails
    }

    // Check for conflicting assessments
    const conflict = checkConflictingAssessments(investigatorResp, threatHunterResp);
    if (conflict.conflicting) {
      log.warn(`Conflicting assessments detected for ${incidentId}: ${conflict.reason}`);
      await transitionIncident(incidentId, 'planning');
      await transitionIncident(incidentId, 'escalated');
      const { doc } = await getIncident(incidentId);
      await escalateIncident(doc, `Conflicting assessments: ${conflict.reason}`, {
        investigation_findings: investigatorResp,
        root_cause: investigatorResp.root_cause,
        affected_services: extractAffectedServices(investigatorResp, threatHunterResp)
      });
      return { incidentId, status: 'escalated', reason: 'conflicting_assessments' };
    }
  } else {
    // Skip threat hunting, go directly to planning
    await transitionIncident(incidentId, 'planning');
  }

  // If we came from threat_hunting, transition to planning
  if (investigatorResp.recommended_next === 'threat_hunt') {
    await transitionIncident(incidentId, 'planning');
  }

  // Continue with common flow: Commander → Executor → Verifier
  return executeFromPlanning(
    incidentId, investigatorResp, threatHunterResp,
    alertContext, 'security'
  );
}

// ============================================================
// Operational Flow
// ============================================================

export async function orchestrateOperationalIncident(sentinelReport) {
  const incidentId = generateIncidentId();
  log.info(`Starting operational incident orchestration: ${incidentId}`);

  const triageLike = {
    alert_id: sentinelReport.anomaly_id || `ANOM-${uuidv4().slice(0, 8)}`,
    priority_score: 0.6,
    enrichment: {
      source_ip: 'internal',
      source_user: 'system',
      asset_criticality: sentinelReport.affected_service_tier || 'tier-2'
    },
    alert_timestamp: sentinelReport.detected_at || new Date().toISOString()
  };

  await createIncidentDocument(incidentId, triageLike, 'operational');
  await transitionIncident(incidentId, 'triaged');
  await transitionIncident(incidentId, 'investigating');

  // For operational incidents: optionally investigate if high-confidence change correlation
  let investigatorResp = null;
  if (sentinelReport.change_correlation?.confidence === 'high') {
    const alertContext = {
      alert_ids: [triageLike.alert_id],
      source_ip: 'internal',
      source_user: sentinelReport.change_correlation?.commit_author || 'unknown',
      affected_assets: sentinelReport.affected_assets || [],
      severity: 'medium',
      initial_indicators: {}
    };

    try {
      const investigatePayload = buildInvestigateRequest(incidentId, 'operational', alertContext);
      investigatorResp = await delegateToAgent('vigil-investigator', incidentId, investigatePayload);
      validateInvestigateResponse(investigatorResp);
      await updateIncidentFields(incidentId, {
        investigation_summary: investigatorResp.root_cause,
        investigation_report: investigatorResp
      });
    } catch (err) {
      log.warn(`Optional investigation for operational incident ${incidentId} failed: ${err.message}`);
    }
  }

  // Skip threat hunting for operational incidents — go directly to planning
  await transitionIncident(incidentId, 'planning');

  // Build a synthetic investigation report if investigator wasn't called
  const effectiveInvestigatorResp = investigatorResp || {
    investigation_id: `INV-${incidentId}-OPS`,
    incident_id: incidentId,
    root_cause: sentinelReport.root_cause_assessment || 'Operational anomaly detected by Sentinel',
    attack_chain: [],
    blast_radius: (sentinelReport.affected_assets || []).map(a => ({
      asset_id: a, impact_type: 'service_degradation', confidence: 0.8
    })),
    threat_intel_matches: [],
    change_correlation: sentinelReport.change_correlation || { matched: false },
    recommended_next: 'plan_remediation'
  };

  return executeFromPlanning(
    incidentId, effectiveInvestigatorResp, null,
    { alert_ids: [triageLike.alert_id], affected_assets: sentinelReport.affected_assets || [] },
    'operational'
  );
}

// ============================================================
// Common Planning → Execution → Verification Flow
// ============================================================

async function executeFromPlanning(incidentId, investigatorResp, threatHunterResp, alertContext, incidentType) {
  let affectedServices = extractAffectedServices(investigatorResp, threatHunterResp);

  // Fallback: if no services extracted from investigation, derive from alert context
  if (affectedServices.length === 0) {
    const alertAssets = alertContext?.affected_assets || [];
    if (alertAssets.length > 0) {
      affectedServices = alertAssets.map(a => typeof a === 'string' ? a : a.asset_id || a.name).filter(Boolean);
    }
    // Last resort: use the alert's alert_ids to build a placeholder service
    if (affectedServices.length === 0) {
      affectedServices = ['unknown-service'];
      log.warn(`No affected services found for ${incidentId}, using fallback`);
    }
  }

  await updateIncidentFields(incidentId, { affected_services: affectedServices });

  // --- Commander: Plan Remediation ---
  let commanderResp;
  try {
    const { doc } = await getIncident(incidentId);
    const planPayload = buildPlanRequest(
      incidentId,
      doc.severity || 'high',
      investigatorResp,
      threatHunterResp,
      affectedServices
    );
    commanderResp = await delegateToAgent('vigil-commander', incidentId, planPayload);
    validatePlanResponse(commanderResp);
  } catch (err) {
    log.error(`Planning failed for ${incidentId}: ${err.message}`);
    await transitionIncident(incidentId, 'escalated');
    const { doc } = await getIncident(incidentId);
    await escalateIncident(doc, `Planning failed: ${err.message}`, {
      root_cause: investigatorResp.root_cause,
      affected_services: affectedServices
    });
    return { incidentId, status: 'escalated', reason: 'planning_failed' };
  }

  // Store remediation plan
  await updateIncidentFields(incidentId, {
    remediation_plan: commanderResp.remediation_plan
  });

  // --- Approval Gate ---
  const { doc: planDoc } = await getIncident(incidentId);
  const approvalGuard = evaluateGuard(planDoc, 'planning', 'awaiting_approval', {
    remediationPlan: commanderResp.remediation_plan
  });

  if (approvalGuard.allowed) {
    await transitionIncident(incidentId, 'awaiting_approval');

    const approvalResult = await waitForApproval(incidentId);

    if (approvalResult === 'timeout' || approvalResult === 'rejected') {
      const { doc: awaitDoc } = await getIncident(incidentId);
      const deniedGuard = evaluateGuard(awaitDoc, 'awaiting_approval', 'escalated', {
        approvalStatus: approvalResult
      });
      if (deniedGuard.allowed) {
        await transitionIncident(incidentId, 'escalated');
        const { doc } = await getIncident(incidentId);
        await escalateIncident(doc, `Approval ${approvalResult} for critical actions`, {
          root_cause: investigatorResp.root_cause,
          affected_services: affectedServices,
          remediation_attempts: commanderResp.remediation_plan
        });
        return { incidentId, status: 'escalated', reason: `approval_${approvalResult}` };
      }
    }
  }

  // --- Executor ---
  await transitionIncident(incidentId, 'executing');
  let executorResp;
  try {
    const executePayload = buildExecuteRequest(incidentId, commanderResp.remediation_plan);
    executorResp = await delegateToAgent('vigil-executor', incidentId, executePayload);
    validateExecuteResponse(executorResp);
  } catch (err) {
    log.error(`Execution failed for ${incidentId}: ${err.message}`);
    // executing → verifying is the only valid transition; then reflect for retry
    await transitionIncident(incidentId, 'verifying');
    return handleReflectionLoop(
      incidentId, investigatorResp, commanderResp, threatHunterResp,
      alertContext, affectedServices,
      `Execution failed: ${err.message}`, incidentType
    );
  }

  // --- Verifier ---
  await transitionIncident(incidentId, 'verifying');
  let verifierResp;
  try {
    // Ensure success_criteria is non-empty — fallback to basic health check.
    // Each criterion MUST include service_name (verifier validates it) and a
    // valid operator from ['lte', 'gte', 'eq'].
    const criteria = commanderResp.remediation_plan.success_criteria?.length > 0
      ? commanderResp.remediation_plan.success_criteria
      : affectedServices.map(svc => ({
          metric: 'error_rate', operator: 'lte', threshold: 5.0, service_name: svc
        }));
    const verifyPayload = buildVerifyRequest(
      incidentId,
      affectedServices,
      criteria
    );
    verifierResp = await delegateToAgent('vigil-verifier', incidentId, verifyPayload);
    validateVerifyResponse(verifierResp);
  } catch (err) {
    log.error(`Verification failed for ${incidentId}: ${err.message}`);
    // Enter reflection loop — handleReflectionLoop transitions verifying → reflecting
    // and handles auto-escalation at the reflection limit
    return handleReflectionLoop(
      incidentId, investigatorResp, commanderResp, threatHunterResp,
      alertContext, affectedServices,
      `Verification agent error: ${err.message}`, incidentType
    );
  }

  // Store verification results
  const { doc: currentDoc } = await getIncident(incidentId);
  const verificationResults = [...(currentDoc.verification_results || []), verifierResp];
  await updateIncidentFields(incidentId, { verification_results: verificationResults });

  // --- Resolution or Reflection ---
  const { doc: verifyDoc } = await getIncident(incidentId);
  const passGuard = evaluateGuard(verifyDoc, 'verifying', 'resolved', {
    verifierResponse: verifierResp
  });

  if (passGuard.allowed) {
    // Compute timing metrics and resolve
    const { doc: resolvedDoc } = await getIncident(incidentId);
    const metrics = computeTimingMetrics(resolvedDoc);
    await transitionIncident(incidentId, 'resolved', {
      ...metrics,
      resolution_type: 'auto_resolved'
    });
    await trackRunbookOutcome(commanderResp.remediation_plan, true);
    log.info(`Incident ${incidentId} resolved successfully`);
    return { incidentId, status: 'resolved', metrics };
  }

  // Verification failed — enter reflection loop
  return handleReflectionLoop(
    incidentId, investigatorResp, commanderResp, threatHunterResp,
    alertContext, affectedServices, verifierResp.failure_analysis, incidentType
  );
}

// ============================================================
// Reflection Loop
// ============================================================

export async function handleReflectionLoop(
  incidentId, originalInvestigatorResp, originalCommanderResp,
  threatHunterResp, alertContext, affectedServices,
  failureAnalysis, incidentType
) {
  let currentFailureAnalysis = failureAnalysis;
  let lastInvestigatorResp = originalInvestigatorResp;
  let lastCommanderResp = originalCommanderResp;

  for (let iteration = 0; iteration < MAX_REFLECTION_LOOPS; iteration++) {
    // transitionIncident will auto-escalate if reflection_count >= MAX
    const updatedDoc = await transitionIncident(incidentId, 'reflecting');

    // Check if auto-escalation was triggered by the state machine guard
    if (updatedDoc.status === 'escalated') {
      const { doc } = await getIncident(incidentId);
      await escalateIncident(doc, `Reflection limit reached (${MAX_REFLECTION_LOOPS}/${MAX_REFLECTION_LOOPS})`, {
        root_cause: lastInvestigatorResp.root_cause,
        affected_services: affectedServices,
        remediation_attempts: lastCommanderResp.remediation_plan,
        verification_results: doc.verification_results
      });
      log.warn(`Incident ${incidentId} escalated after exhausting reflection loops`);
      return { incidentId, status: 'escalated', reason: 'reflection_limit_reached' };
    }

    log.info(`Incident ${incidentId} entering reflection loop (count: ${updatedDoc.reflection_count})`);

    // Re-investigate with previous failure context (skip threat hunter on reflections)
    await transitionIncident(incidentId, 'investigating');

    let reinvestigatorResp;
    try {
      const reinvestigatePayload = buildInvestigateRequest(
        incidentId, incidentType, alertContext, currentFailureAnalysis
      );
      reinvestigatorResp = await delegateToAgent('vigil-investigator', incidentId, reinvestigatePayload);
      validateInvestigateResponse(reinvestigatorResp);
    } catch (err) {
      log.error(`Re-investigation failed for ${incidentId}: ${err.message}`);
      await transitionIncident(incidentId, 'planning');
      await transitionIncident(incidentId, 'escalated');
      const { doc } = await getIncident(incidentId);
      await escalateIncident(doc, `Re-investigation failed during reflection: ${err.message}`, {
        root_cause: lastInvestigatorResp.root_cause,
        affected_services: affectedServices
      });
      return { incidentId, status: 'escalated', reason: 'reinvestigation_failed' };
    }

    lastInvestigatorResp = reinvestigatorResp;

    await updateIncidentFields(incidentId, {
      investigation_summary: reinvestigatorResp.root_cause,
      investigation_report: reinvestigatorResp
    });

    // Skip threat hunting during reflections — go directly to planning
    await transitionIncident(incidentId, 'planning');

    // Re-plan with updated investigation
    let commanderResp;
    try {
      const { doc } = await getIncident(incidentId);
      const planPayload = buildPlanRequest(
        incidentId,
        doc.severity || 'high',
        reinvestigatorResp,
        threatHunterResp,
        affectedServices
      );
      commanderResp = await delegateToAgent('vigil-commander', incidentId, planPayload);
      validatePlanResponse(commanderResp);
    } catch (err) {
      log.error(`Re-planning failed for ${incidentId}: ${err.message}`);
      await transitionIncident(incidentId, 'escalated');
      const { doc } = await getIncident(incidentId);
      await escalateIncident(doc, `Re-planning failed during reflection: ${err.message}`, {
        root_cause: reinvestigatorResp.root_cause,
        affected_services: affectedServices
      });
      return { incidentId, status: 'escalated', reason: 'replanning_failed' };
    }

    lastCommanderResp = commanderResp;

    await updateIncidentFields(incidentId, {
      remediation_plan: commanderResp.remediation_plan
    });

    // Re-execute (no approval gate on reflections — already approved in first pass)
    await transitionIncident(incidentId, 'executing');

    let executorResp;
    try {
      const executePayload = buildExecuteRequest(incidentId, commanderResp.remediation_plan);
      executorResp = await delegateToAgent('vigil-executor', incidentId, executePayload);
      validateExecuteResponse(executorResp);
    } catch (err) {
      log.error(`Re-execution failed for ${incidentId}: ${err.message}`);
      // executing → verifying is the only valid transition
      await transitionIncident(incidentId, 'verifying');
      currentFailureAnalysis = `Execution failed: ${err.message}`;
      continue; // next iteration will transition verifying → reflecting
    }

    // Re-verify
    await transitionIncident(incidentId, 'verifying');

    let verifierResp;
    try {
      const reflectCriteria = commanderResp.remediation_plan.success_criteria?.length > 0
        ? commanderResp.remediation_plan.success_criteria
        : affectedServices.map(svc => ({
            metric: 'error_rate', operator: 'lte', threshold: 5.0, service_name: svc
          }));
      const verifyPayload = buildVerifyRequest(
        incidentId,
        affectedServices,
        reflectCriteria
      );
      verifierResp = await delegateToAgent('vigil-verifier', incidentId, verifyPayload);
      validateVerifyResponse(verifierResp);
    } catch (err) {
      log.error(`Re-verification failed for ${incidentId}: ${err.message}`);
      currentFailureAnalysis = `Verification agent error: ${err.message}`;
      continue; // next iteration will transition verifying → reflecting
    }

    // Store verification results
    const { doc: currentDoc } = await getIncident(incidentId);
    const verificationResults = [...(currentDoc.verification_results || []), verifierResp];
    await updateIncidentFields(incidentId, { verification_results: verificationResults });

    const reflectPassGuard = evaluateGuard(currentDoc, 'verifying', 'resolved', {
      verifierResponse: verifierResp
    });

    if (reflectPassGuard.allowed) {
      const { doc: resolvedDoc } = await getIncident(incidentId);
      const metrics = computeTimingMetrics(resolvedDoc);
      await transitionIncident(incidentId, 'resolved', {
        ...metrics,
        resolution_type: 'auto_resolved'
      });
      await trackRunbookOutcome(commanderResp.remediation_plan, true);
      log.info(`Incident ${incidentId} resolved after reflection loop ${currentDoc.reflection_count}`);
      return { incidentId, status: 'resolved', metrics };
    }

    // Still failing — update failure analysis for next iteration
    currentFailureAnalysis = verifierResp.failure_analysis;
  }

  // Exhausted all iterations without resolution — escalate
  // Transition verifying → reflecting → escalated (state machine requires reflecting step)
  try { await transitionIncident(incidentId, 'reflecting'); } catch { /* may already be reflecting */ }
  await transitionIncident(incidentId, 'escalated');
  await trackRunbookOutcome(lastCommanderResp.remediation_plan, false);
  const { doc } = await getIncident(incidentId);
  await escalateIncident(doc, `Reflection limit reached (${MAX_REFLECTION_LOOPS}/${MAX_REFLECTION_LOOPS})`, {
    root_cause: lastInvestigatorResp.root_cause,
    affected_services: affectedServices,
    remediation_attempts: lastCommanderResp.remediation_plan,
    verification_results: doc.verification_results
  });
  log.warn(`Incident ${incidentId} escalated after exhausting reflection loops`);
  return { incidentId, status: 'escalated', reason: 'reflection_limit_reached' };
}
