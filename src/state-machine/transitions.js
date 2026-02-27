import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';
import { parsePositiveInt } from '../utils/env.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('state-machine');

const MAX_REFLECTION_LOOPS = parsePositiveInt('VIGIL_MAX_REFLECTION_LOOPS', 3);

// Terminal states that trigger asynchronous Analyst analysis
const TERMINAL_STATES = ['resolved', 'suppressed', 'escalated'];

/**
 * Fire-and-forget trigger for Analyst post-incident analysis.
 * Uses setImmediate to defer past the current function's return,
 * with explicit .catch() to prevent unhandled promise rejections.
 */
function triggerAnalyst(incidentId, terminalState, incidentData) {
  setImmediate(() => {
    import('./analyst-bridge.js')
      .then(({ analyzeIncident }) => analyzeIncident(incidentId, terminalState, incidentData))
      .catch(err => log.error(`[Analyst] Failed for ${incidentId}: ${err.stack || err.message}`));
  });
  log.info(`[Analyst] Triggered analysis for ${incidentId} (${terminalState})`);
}

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

  // Guard: redirect reflecting → escalated when reflection limit reached.
  // Must first complete the reflecting transition so the doc state allows
  // the subsequent escalated transition (reflecting → escalated is valid,
  // but the caller's current state e.g. verifying → escalated is not).
  if (newStatus === 'reflecting' && (doc.reflection_count || 0) >= MAX_REFLECTION_LOOPS) {
    log.warn(
      `Reflection limit reached (${doc.reflection_count}/${MAX_REFLECTION_LOOPS}). ` +
      `Auto-escalating incident ${incidentId}.`
    );
    // Fall through to complete the verifying → reflecting transition first
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

  // Terminal state handling (DRY: resolved, suppressed, escalated)
  if (TERMINAL_STATES.includes(newStatus)) {
    updateFields.resolved_at = now;
    const resolutionMap = {
      resolved: metadata.resolution_type || 'auto_resolved',
      suppressed: 'suppressed',
      escalated: 'escalated'
    };
    updateFields.resolution_type = resolutionMap[newStatus];
    updateFields.total_duration_seconds = Math.max(0, Math.floor(
      (new Date(now) - new Date(doc.created_at)) / 1000
    ));
  }

  // Persist with optimistic concurrency control + retry on conflict.
  // External processes (demo scenarios, webhook handlers) may update the
  // incident doc concurrently, causing seq_no mismatches. Retry by re-reading
  // the latest doc version and re-applying the update.
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // On retry, re-read the latest seq_no/primary_term
    let seqNo = _seq_no;
    let primaryTerm = _primary_term;
    if (attempt > 0) {
      const latest = await getIncident(incidentId);
      seqNo = latest._seq_no;
      primaryTerm = latest._primary_term;
    }

    try {
      await client.update({
        index: 'vigil-incidents',
        id: incidentId,
        if_seq_no: seqNo,
        if_primary_term: primaryTerm,
        doc: updateFields,
        refresh: 'wait_for'
      });
      break; // success
    } catch (err) {
      if (err.meta?.statusCode === 409 && attempt < MAX_RETRIES) {
        log.warn(`Conflict on transition ${currentStatus} → ${newStatus} for ${incidentId}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      if (err.meta?.statusCode === 409) {
        throw new ConcurrencyError(incidentId);
      }
      throw err;
    }
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
    log.error(`Failed to write audit record for ${incidentId}: ${auditErr.stack || auditErr.message}`);
  }

  const updatedDoc = { ...doc, ...updateFields };

  log.info(`Incident ${incidentId}: ${currentStatus} → ${newStatus}`);

  // Trigger Analyst on terminal state transitions (fire-and-forget)
  if (TERMINAL_STATES.includes(newStatus)) {
    triggerAnalyst(incidentId, newStatus, updatedDoc);
  }

  return updatedDoc;
}
