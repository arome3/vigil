import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';
import { getIncident } from '../../state-machine/transitions.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('coordinator-escalation');

const APPROVAL_TIMEOUT_MINUTES = parseInt(process.env.VIGIL_APPROVAL_TIMEOUT_MINUTES || '15', 10);

export async function escalateIncident(incidentDoc, reason, context = {}) {
  const incidentId = incidentDoc.incident_id;

  // Idempotency: check if already escalated
  const { doc: current, _seq_no, _primary_term } = await getIncident(incidentId);
  if (current.escalation_triggered === true) {
    log.info(`Escalation already triggered for ${incidentId}, skipping duplicate`);
    return { skipped: true, reason: 'already_escalated' };
  }

  // Set the idempotency flag with optimistic concurrency
  try {
    await client.update({
      index: 'vigil-incidents',
      id: incidentId,
      if_seq_no: _seq_no,
      if_primary_term: _primary_term,
      doc: { escalation_triggered: true, escalation_reason: reason },
      refresh: 'wait_for'
    });
  } catch (err) {
    if (err.meta?.statusCode === 409) {
      log.info(`Concurrent escalation attempt for ${incidentId}, skipping`);
      return { skipped: true, reason: 'concurrency_conflict' };
    }
    throw err;
  }

  // Build escalation notification
  const notificationPayload = {
    task: 'notify',
    incident_id: incidentId,
    severity: incidentDoc.severity || 'high',
    channel: 'pagerduty',
    message: `Vigil escalation: ${reason}`,
    details: {
      incident_type: incidentDoc.incident_type,
      root_cause: context.root_cause || incidentDoc.investigation_summary || 'Unknown',
      affected_services: context.affected_services || incidentDoc.affected_services || [],
      investigation_findings: context.investigation_findings || null,
      remediation_attempts: context.remediation_attempts || null,
      verification_results: context.verification_results || null,
      escalation_reason: reason,
      reflection_count: incidentDoc.reflection_count || 0
    }
  };

  const envelope = createEnvelope(
    'vigil-coordinator',
    'vigil-wf-notify',
    incidentId,
    notificationPayload
  );

  try {
    await sendA2AMessage('vigil-wf-notify', envelope, { timeout: 30_000 });
    log.info(`Escalation notification sent for ${incidentId}: ${reason}`);
  } catch (notifyErr) {
    log.error(`Failed to send escalation notification for ${incidentId}: ${notifyErr.message}`);
    // Escalation flag was already set — notification failure is logged but doesn't unset the flag
  }

  return { skipped: false, reason };
}

export function checkConflictingAssessments(investigatorResp, threatHunterResp) {
  if (!investigatorResp || !threatHunterResp) return { conflicting: false };

  // Check if the threat hunter found assets the investigator said were clean
  const investigatorConfirmed = new Set(
    (investigatorResp.blast_radius || [])
      .filter(a => a.confidence >= 0.7)
      .map(a => a.asset_id)
  );

  const hunterConfirmed = new Set(
    (threatHunterResp.confirmed_compromised || []).map(a => a.asset_id)
  );

  // Assets found by hunter but not by investigator (at high confidence)
  const hunterOnly = [...hunterConfirmed].filter(id => !investigatorConfirmed.has(id));

  // Check for contradictory root cause signals
  const investigatorRootCause = investigatorResp.root_cause || '';
  const hunterFindings = (threatHunterResp.suspected_compromised || [])
    .map(s => s.reason)
    .join(' ');

  // Simple heuristic: significant divergence in scope (both must have findings to conflict)
  if (hunterOnly.length > 0 && investigatorConfirmed.size > 0 && hunterOnly.length >= investigatorConfirmed.size) {
    return {
      conflicting: true,
      reason: `Threat Hunter found ${hunterOnly.length} compromised assets not identified by Investigator: [${hunterOnly.join(', ')}]`,
      investigator_scope: [...investigatorConfirmed],
      hunter_scope: [...hunterConfirmed]
    };
  }

  return { conflicting: false };
}

export function checkApprovalTimeout(incidentDoc, approvalStartTime) {
  if (!approvalStartTime) return false;

  const elapsed = Date.now() - new Date(approvalStartTime).getTime();
  const timeoutMs = APPROVAL_TIMEOUT_MINUTES * 60 * 1000;

  return elapsed >= timeoutMs;
}
