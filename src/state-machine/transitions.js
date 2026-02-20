import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';
import { parsePositiveInt } from '../utils/env.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('state-machine');

const MAX_REFLECTION_LOOPS = parsePositiveInt('VIGIL_MAX_REFLECTION_LOOPS', 3);

// --- Error Classes ---

export class InvalidTransitionError extends Error {
  constructor(currentStatus, newStatus, allowed) {
    super(
      `Invalid transition: ${currentStatus} → ${newStatus}. ` +
      `Allowed transitions from '${currentStatus}': [${allowed?.join(', ') || 'none'}]`
    );
    this.name = 'InvalidTransitionError';
    this.currentStatus = currentStatus;
    this.newStatus = newStatus;
    this.allowed = allowed;
  }
}

export class ConcurrencyError extends Error {
  constructor(incidentId) {
    super(`Concurrency conflict updating incident ${incidentId}. Document was modified by another process.`);
    this.name = 'ConcurrencyError';
    this.incidentId = incidentId;
  }
}

// --- Valid States & Transitions ---

export const VALID_STATES = Object.freeze([
  'detected',
  'triaged',
  'investigating',
  'threat_hunting',
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'reflecting',
  'resolved',
  'escalated',
  'suppressed'
]);

export const VALID_TRANSITIONS = Object.freeze({
  'detected':          ['triaged'],
  'triaged':           ['investigating', 'suppressed'],
  'investigating':     ['threat_hunting', 'planning'],
  'threat_hunting':    ['planning'],
  'planning':          ['awaiting_approval', 'executing'],
  'awaiting_approval': ['executing', 'escalated'],
  'executing':         ['verifying'],
  'verifying':         ['resolved', 'reflecting'],
  'reflecting':        ['investigating', 'escalated'],
  'resolved':          [],
  'escalated':         ['investigating'],
  'suppressed':        []
});

// --- Core Functions ---

export async function getIncident(incidentId) {
  const result = await client.get({
    index: 'vigil-incidents',
    id: incidentId
  });

  return {
    doc: result._source,
    _seq_no: result._seq_no,
    _primary_term: result._primary_term
  };
}

export async function transitionIncident(incidentId, newStatus, metadata = {}) {
  const { doc, _seq_no, _primary_term } = await getIncident(incidentId);
  const currentStatus = doc.status;
  const allowed = VALID_TRANSITIONS[currentStatus];

  // Validate transition
  if (!allowed || !allowed.includes(newStatus)) {
    throw new InvalidTransitionError(currentStatus, newStatus, allowed);
  }

  // Guard: redirect reflecting → escalated when reflection limit reached
  if (newStatus === 'reflecting' && (doc.reflection_count || 0) >= MAX_REFLECTION_LOOPS) {
    log.warn(
      `Reflection limit reached (${doc.reflection_count}/${MAX_REFLECTION_LOOPS}). ` +
      `Auto-escalating incident ${incidentId}.`
    );
    return transitionIncident(incidentId, 'escalated', {
      ...metadata,
      escalation_reason: 'reflection_limit_reached'
    });
  }

  const now = new Date().toISOString();

  // Build update body
  const updateFields = {
    status: newStatus,
    updated_at: now,
    ...metadata
  };

  // Track state entry timestamps
  const stateTimestamps = doc._state_timestamps || {};
  stateTimestamps[newStatus] = now;
  updateFields._state_timestamps = stateTimestamps;

  // Increment reflection counter when entering reflecting state
  if (newStatus === 'reflecting') {
    updateFields.reflection_count = (doc.reflection_count || 0) + 1;
  }

  // Terminal state handling
  if (newStatus === 'resolved') {
    updateFields.resolved_at = now;
    updateFields.resolution_type = metadata.resolution_type || 'auto_resolved';
    updateFields.total_duration_seconds = Math.floor(
      (new Date(now) - new Date(doc.created_at)) / 1000
    );
  }

  if (newStatus === 'suppressed') {
    updateFields.resolved_at = now;
    updateFields.resolution_type = 'suppressed';
    updateFields.total_duration_seconds = Math.floor(
      (new Date(now) - new Date(doc.created_at)) / 1000
    );
  }

  if (newStatus === 'escalated') {
    updateFields.resolution_type = 'escalated';
  }

  // Persist with optimistic concurrency control
  try {
    await client.update({
      index: 'vigil-incidents',
      id: incidentId,
      if_seq_no: _seq_no,
      if_primary_term: _primary_term,
      doc: updateFields,
      refresh: 'wait_for'
    });
  } catch (err) {
    if (err.meta?.statusCode === 409) {
      throw new ConcurrencyError(incidentId);
    }
    throw err;
  }

  // Log audit record
  try {
    await client.index({
      index: 'vigil-actions',
      document: {
        '@timestamp': now,
        action_id: `AUD-${uuidv4().slice(0, 8).toUpperCase()}`,
        incident_id: incidentId,
        agent_name: 'vigil-coordinator',
        action_type: 'state_transition',
        action_detail: `${currentStatus} → ${newStatus}`,
        previous_status: currentStatus,
        new_status: newStatus,
        metadata: metadata,
        execution_status: 'completed'
      }
    });
  } catch (auditErr) {
    log.error(`Failed to write audit record for ${incidentId}: ${auditErr.message}`);
  }

  log.info(`Incident ${incidentId}: ${currentStatus} → ${newStatus}`);

  return { ...doc, ...updateFields };
}
