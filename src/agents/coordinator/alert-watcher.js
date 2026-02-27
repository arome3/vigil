import { orchestrateSecurityIncident, orchestrateOperationalIncident } from './delegation.js';
import { buildTriageRequest, validateTriageResponse } from '../../a2a/contracts.js';
import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { parsePositiveInt } from '../../utils/env.js';

const log = createLogger('alert-watcher');

const POLL_INTERVAL_MS = parsePositiveInt('VIGIL_ALERT_POLL_INTERVAL_MS', 5000);
const BATCH_SIZE = parsePositiveInt('VIGIL_ALERT_BATCH_SIZE', 10);
const MAX_CONSECUTIVE_FAILURES = parsePositiveInt('VIGIL_ALERT_MAX_POLL_ERRORS', 5);
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

let pollerHandle = null;
let currentBackoff = INITIAL_BACKOFF_MS;
let consecutiveFailures = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function determineIncidentType(alertDoc) {
  const ruleId = alertDoc.rule_id || alertDoc._source?.rule_id || '';
  if (/^(sentinel-|anomaly-|ops-)/.test(ruleId)) return 'operational';
  return 'security';
}

async function markAlertProcessed(alertId, error = null) {
  try {
    const updateFields = { processed_at: new Date().toISOString() };
    if (error) {
      updateFields.error = error;
    }
    await client.update({
      index: 'vigil-alert-claims',
      id: alertId,
      doc: updateFields,
      refresh: 'wait_for'
    });
  } catch (err) {
    log.warn(`Failed to mark alert ${alertId} as processed: ${err.message}`);
  }
}

function buildSentinelReport(alertDoc) {
  const source = alertDoc._source || alertDoc;
  return {
    anomaly_id: source.alert_id || alertDoc._id,
    detected_at: source.timestamp || new Date().toISOString(),
    affected_service_tier: source.affected_service_tier || 'tier-2',
    affected_assets: source.affected_assets || [],
    root_cause_assessment: source.root_cause_assessment || null,
    change_correlation: source.change_correlation || { matched: false, confidence: 'low' }
  };
}

// ---------------------------------------------------------------------------
// Alert claiming (deduplication via optimistic concurrency)
// ---------------------------------------------------------------------------

async function claimAlert(hit) {
  try {
    // Use op_type: 'create' on the claims index — returns 409 if already claimed
    await client.index({
      index: 'vigil-alert-claims',
      id: hit._id,
      op_type: 'create',
      document: {
        alert_id: hit._source?.alert_id || hit._id,
        claimed_at: new Date().toISOString()
      },
      refresh: 'wait_for'
    });
    return true;
  } catch (err) {
    if (err.meta?.statusCode === 409) {
      log.debug(`Alert ${hit._id} already claimed, skipping`);
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Telemetry (best-effort, never throws)
// ---------------------------------------------------------------------------

async function indexTelemetry(data) {
  try {
    await client.index({
      index: 'vigil-watcher-telemetry',
      document: {
        '@timestamp': new Date().toISOString(),
        component: 'alert-watcher',
        ...data
      }
    });
  } catch (err) {
    log.debug(`Telemetry indexing failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// processAlert
// ---------------------------------------------------------------------------

export async function processAlert(alertDoc) {
  const alertId = alertDoc._id;
  const source = alertDoc._source || alertDoc;

  // 1. Triage via A2A
  let triageResponse;
  try {
    const triageReq = buildTriageRequest(source);
    const envelope = createEnvelope('vigil-coordinator', 'vigil-triage', alertId, triageReq);
    triageResponse = await sendA2AMessage('vigil-triage', envelope);
    validateTriageResponse(triageResponse);
  } catch (err) {
    log.error(`Triage failed for alert ${alertId}: ${err.message}`);
    await markAlertProcessed(alertId, `Triage failed: ${err.message}`);
    return;
  }

  // 2. Mark processed
  await markAlertProcessed(alertId);

  // 3. Route to orchestration
  try {
    const incidentType = determineIncidentType(alertDoc);

    if (incidentType === 'operational') {
      const sentinelReport = buildSentinelReport(alertDoc);
      await orchestrateOperationalIncident(sentinelReport);
    } else {
      await orchestrateSecurityIncident(triageResponse, source);
    }
  } catch (err) {
    log.error(`Orchestration failed for alert ${alertId}: ${err.message}`, {
      alertId,
      disposition: triageResponse.disposition,
      priority_score: triageResponse.priority_score
    });
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function pollAlerts() {
  const startTime = Date.now();
  let hits;
  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    // Fetch IDs of already-claimed alerts to exclude them
    let claimedIds = [];
    try {
      const claimsResult = await client.search({
        index: 'vigil-alert-claims',
        size: 1000,
        _source: false,
        query: { match_all: {} }
      });
      claimedIds = (claimsResult.hits?.hits || []).map(h => h._id);
    } catch (err) {
      // Claims index may not exist yet — treat as no claims
      if (err.meta?.statusCode !== 404) {
        log.warn(`Failed to fetch claims: ${err.message}`);
      }
    }

    const alertQuery = claimedIds.length > 0
      ? { bool: { must_not: [{ ids: { values: claimedIds } }] } }
      : { match_all: {} };

    const result = await client.search({
      index: 'vigil-alerts-default',
      size: BATCH_SIZE,
      query: alertQuery,
      sort: [{ '@timestamp': 'asc' }]
    });
    hits = result.hits?.hits || [];
    currentBackoff = INITIAL_BACKOFF_MS;
    consecutiveFailures = 0;
  } catch (err) {
    log.error(`Alert poll failed: ${err.message}`);
    consecutiveFailures++;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log.error(`Circuit breaker tripped: ${consecutiveFailures} consecutive poll failures, stopping watcher`);
      stopAlertWatcher();
    }

    await indexTelemetry({
      alerts_found: 0, alerts_processed: 0, alerts_skipped: 0,
      errors: 1, poll_duration_ms: Date.now() - startTime,
      consecutive_failures: consecutiveFailures,
      current_backoff_ms: currentBackoff
    });
    return;
  }

  if (hits.length === 0) {
    log.debug('No unprocessed alerts found');
    await indexTelemetry({
      alerts_found: 0, alerts_processed: 0, alerts_skipped: 0,
      errors: 0, poll_duration_ms: Date.now() - startTime,
      consecutive_failures: consecutiveFailures,
      current_backoff_ms: currentBackoff
    });
    return;
  }

  log.info(`Processing ${hits.length} alert(s)`);

  for (const hit of hits) {
    try {
      const claimed = await claimAlert(hit);
      if (!claimed) {
        skippedCount++;
        continue;
      }
      await processAlert(hit);
      processedCount++;
    } catch (err) {
      errorCount++;
      log.error(`Unexpected error processing alert ${hit._id}: ${err.message}`);
    }
  }

  await indexTelemetry({
    alerts_found: hits.length,
    alerts_processed: processedCount,
    alerts_skipped: skippedCount,
    errors: errorCount,
    poll_duration_ms: Date.now() - startTime,
    consecutive_failures: consecutiveFailures,
    current_backoff_ms: currentBackoff
  });
}

// ---------------------------------------------------------------------------
// Start / Stop (recursive setTimeout loop)
// ---------------------------------------------------------------------------

async function scheduleNextPoll() {
  await pollAlerts();

  if (pollerHandle !== null) {
    let delay;
    if (consecutiveFailures > 0) {
      delay = currentBackoff;
      // Double backoff for next failure (use current value first, then escalate)
      currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF_MS);
    } else {
      delay = POLL_INTERVAL_MS;
    }
    pollerHandle = setTimeout(scheduleNextPoll, delay);
  }
}

export function startAlertWatcher(options = {}) {
  if (pollerHandle) {
    log.warn('Alert watcher already running, ignoring start');
    return;
  }

  log.info(`Starting alert watcher (interval: ${POLL_INTERVAL_MS}ms, batch: ${BATCH_SIZE})`);
  currentBackoff = INITIAL_BACKOFF_MS;
  consecutiveFailures = 0;

  // Use a sentinel value to indicate "running" before the first poll completes
  pollerHandle = true;
  scheduleNextPoll();
}

export function stopAlertWatcher() {
  if (pollerHandle) {
    if (typeof pollerHandle !== 'boolean') {
      clearTimeout(pollerHandle);
    }
    pollerHandle = null;
    currentBackoff = INITIAL_BACKOFF_MS;
    consecutiveFailures = 0;
    log.info('Alert watcher stopped');
  }
}
