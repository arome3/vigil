import { v4 as uuidv4 } from 'uuid';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { embedSafe } from '../../utils/embed-helpers.js';
import {
  RUNBOOK_MATCH_THRESHOLD, HEALTH_SCORE_THRESHOLD, DEDUP_MIN_SCORE
} from './constants.js';

const log = createLogger('analyst:runbook-generator');

/**
 * Run runbook generation for a resolved incident.
 *
 * Eligibility: Commander had no matching runbook (match_score < 0.5)
 * AND Verifier confirmed success (health_score >= 0.8) on first attempt
 * (reflection_count == 0).
 *
 * @param {object} incidentData - Full incident document from vigil-incidents
 * @returns {Promise<object|null>} Learning record written, or null if ineligible
 */
export async function runRunbookGeneration(incidentData) {
  const incidentId = incidentData.incident_id || 'unknown';
  log.info(`Evaluating runbook generation eligibility for ${incidentId}`);

  // Check eligibility: must be resolved
  if (incidentData.status !== 'resolved') {
    log.info(`${incidentId}: not resolved (${incidentData.status}) — skipping runbook generation`);
    return null;
  }

  // Check: Commander had no good runbook match
  const matchScore = incidentData.remediation_plan?.runbook_match_score
    ?? incidentData.commander_plan_match_score
    ?? null;

  if (matchScore !== null && matchScore >= RUNBOOK_MATCH_THRESHOLD) {
    log.info(
      `${incidentId}: runbook_match_score ${matchScore} >= ${RUNBOOK_MATCH_THRESHOLD} — ` +
      `existing runbook was used, skipping generation`
    );
    return null;
  }

  // Check: Verifier confirmed success on first attempt
  const reflectionCount = incidentData.reflection_count || 0;
  if (reflectionCount > 0) {
    log.info(
      `${incidentId}: reflection_count ${reflectionCount} > 0 — ` +
      `not a first-attempt success, skipping runbook generation`
    );
    return null;
  }

  // Get the final health score from verification results
  const verificationResults = incidentData.verification_results || [];
  const lastVerification = verificationResults[verificationResults.length - 1];
  const healthScore = lastVerification?.health_score
    ?? incidentData.verification?.health_score
    ?? 0;

  if (healthScore < HEALTH_SCORE_THRESHOLD) {
    log.info(
      `${incidentId}: health_score ${healthScore} < ${HEALTH_SCORE_THRESHOLD} — ` +
      `insufficient success confidence, skipping runbook generation`
    );
    return null;
  }

  log.info(
    `${incidentId}: eligible for runbook generation ` +
    `(match_score: ${matchScore ?? 'none'}, health_score: ${healthScore}, reflections: 0)`
  );

  // Extract plan actions
  const planActions = incidentData.remediation_plan?.actions || [];
  if (planActions.length === 0) {
    log.warn(`${incidentId}: no remediation actions found — cannot generate runbook`);
    return null;
  }

  // Build runbook from executed plan
  const targetSystems = [...new Set(
    planActions
      .map(a => a.target_system)
      .filter(Boolean)
  )];

  const tags = [
    ...(incidentData.incident_type ? [incidentData.incident_type] : []),
    ...(incidentData.attack_vector ? [incidentData.attack_vector] : []),
    ...targetSystems
  ];

  const rootCause = incidentData.root_cause || incidentData.investigation_summary || '';
  const title = deriveRunbookTitle(rootCause, planActions);
  const description = deriveRunbookDescription(rootCause, planActions, incidentId);

  const steps = planActions
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(action => action.description || action.action_detail || String(action.action_type));

  const runbookId = `rbk-auto-${uuidv4().slice(0, 12)}`;
  // Empty array = all severities applicable (no restriction)
  const severityApplicability = incidentData.severity
    ? [incidentData.severity]
    : [];

  // Assemble content text for embedding
  const contentText = [title, description, ...steps].join('\n');

  const contentVector = await embedSafe(contentText, log, 'content_vector');

  const now = new Date().toISOString();

  // Write the runbook to vigil-runbooks
  const runbookDoc = {
    runbook_id: runbookId,
    title,
    description,
    content: contentText,
    steps: steps.map((step, i) => ({
      order: i + 1,
      action: step,
      target_system: planActions[i]?.target_system || null,
      approval_required: planActions[i]?.approval_required || false
    })),
    incident_types: incidentData.incident_type ? [incidentData.incident_type] : [],
    applicable_services: targetSystems,
    severity_levels: severityApplicability,
    historical_success_rate: 1.0,
    times_used: 1,
    last_used_at: now,
    tags
  };

  if (contentVector) {
    runbookDoc.content_vector = contentVector;
  }

  // Check for duplicate runbooks by content similarity (graceful degradation)
  try {
    const dedupQuery = {
      bool: {
        must: [{ match: { content: contentText } }],
        should: contentVector
          ? [{ knn: { field: 'content_vector', query_vector: contentVector, num_candidates: 5 } }]
          : [],
        ...(incidentData.incident_type
          ? { filter: [{ terms: { incident_types: [incidentData.incident_type] } }] }
          : {})
      }
    };

    const existingRunbooks = await client.search({
      index: 'vigil-runbooks',
      query: dedupQuery,
      size: 1,
      min_score: DEDUP_MIN_SCORE,
      timeout: '30s'
    });

    if (existingRunbooks.hits.hits.length > 0) {
      const existing = existingRunbooks.hits.hits[0];
      log.info(`${incidentId}: similar runbook already exists (${existing._source.runbook_id}, score: ${existing._max_score}) — skipping`);
      return null;
    }
  } catch (dedupErr) {
    log.warn(`${incidentId}: dedup check failed (${dedupErr.message}) — proceeding with generation`);
  }

  try {
    await withRetry(() => client.index({
      index: 'vigil-runbooks',
      id: runbookId,
      document: runbookDoc,
      op_type: 'create',
      refresh: 'wait_for'
    }), { label: `index runbook ${runbookId}` });
  } catch (err) {
    if (err.meta?.statusCode === 409) {
      log.info(`Runbook ${runbookId} already exists — skipping duplicate write`);
      return null;
    }
    throw err;
  }

  log.info(`Wrote new runbook: ${runbookId} — "${title}"`);

  // Write learning record to vigil-learnings
  const summary =
    `Generated runbook '${title}' from successful ad-hoc remediation of ${incidentId}. ` +
    `The Commander built a novel ${planActions.length}-step plan ` +
    `(${matchScore !== null ? `best match score ${matchScore}` : 'no matching runbook found'}). ` +
    `Verifier confirmed resolution with health_score ${healthScore} on first attempt.`;

  const summaryVector = await embedSafe(summary, log, 'summary_vector');

  const learningRecord = {
    '@timestamp': now,
    learning_id: `LRN-RBK-${uuidv4().slice(0, 8).toUpperCase()}`,
    learning_type: 'runbook_generation',
    incident_ids: [incidentId],
    analysis_window: {
      start: incidentData.created_at || now,
      end: now,
      incident_count: 1
    },
    summary,
    confidence: Math.min(0.95, Math.max(0.7, healthScore)),
    data: {
      generated_runbook: {
        runbook_id: runbookId,
        title,
        description,
        steps,
        target_systems: targetSystems,
        severity_applicability: severityApplicability,
        tags,
        historical_success_rate: 1.0,
        times_used: 1
      },
      source_incident: incidentId,
      commander_plan_match_score: matchScore,
      verifier_health_score: healthScore,
      reflection_loops: 0
    },
    applied: true,
    applied_at: now,
    reviewed_by: null,
    review_status: 'auto_applied'
  };

  if (summaryVector) {
    learningRecord.summary_vector = summaryVector;
  }

  try {
    await withRetry(() => client.index({
      index: 'vigil-learnings',
      id: learningRecord.learning_id,
      document: learningRecord,
      op_type: 'create',
      refresh: 'wait_for'
    }), { label: `index ${learningRecord.learning_id}` });
  } catch (err) {
    if (err.meta?.statusCode === 409) {
      log.info(`${learningRecord.learning_id} already exists — skipping duplicate write`);
      return learningRecord;
    }
    throw err;
  }

  log.info(`Runbook generation learning record written: ${learningRecord.learning_id}`);

  return learningRecord;
}

// TODO: wire incrementRunbookUsage from verifier after successful resolution

/**
 * Update runbook usage statistics after it is used by Commander/Verifier.
 * Uses exponential decay: new_rate = old_rate * 0.9 + outcome * 0.1
 *
 * @param {string} runbookId - The runbook document ID
 * @param {boolean} wasSuccessful - Whether the runbook execution succeeded
 */
export async function incrementRunbookUsage(runbookId, wasSuccessful) {
  try {
    const result = await client.get({ index: 'vigil-runbooks', id: runbookId });
    const src = result._source;
    const timesUsed = (src.times_used || 0) + 1;
    const newRate = (src.historical_success_rate || 1.0) * 0.9 + (wasSuccessful ? 1 : 0) * 0.1;
    await client.update({
      index: 'vigil-runbooks', id: runbookId,
      doc: { times_used: timesUsed, historical_success_rate: Math.round(newRate * 100) / 100, last_used_at: new Date().toISOString() }
    });
  } catch (err) {
    log.warn(`Failed to update runbook usage for ${runbookId}: ${err.message}`);
  }
}

/**
 * Derive a runbook title from root cause and actions.
 * Caps at 2 action types to avoid unwieldy titles.
 */
function deriveRunbookTitle(rootCause, actions) {
  // Extract key action types
  const actionTypes = [...new Set(actions.map(a => a.action_type).filter(Boolean))];
  if (actionTypes.length > 0) {
    const format = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const display = actionTypes.slice(0, 2).map(format).join(' and ');
    return display + (actionTypes.length > 2 ? ' ...' : '');
  }

  // Fall back to a truncated root cause
  if (rootCause.length > 60) {
    return rootCause.slice(0, 57) + '...';
  }
  return rootCause || 'Auto-Generated Remediation Runbook';
}

/**
 * Derive a runbook description from context.
 */
function deriveRunbookDescription(rootCause, actions, incidentId) {
  const targetSystems = [...new Set(actions.map(a => a.target_system).filter(Boolean))];
  return (
    `Auto-generated from incident ${incidentId}. ` +
    `Root cause: ${rootCause || 'unknown'}. ` +
    `${actions.length} remediation steps targeting ${targetSystems.join(', ') || 'various systems'}.`
  );
}
