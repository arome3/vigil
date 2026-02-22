import cron from 'node-cron';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { runRetrospective } from './retrospective-writer.js';
import { runRunbookGeneration } from './runbook-generator.js';
import { runWeightCalibration } from './weight-calibrator.js';
import { runThresholdTuning } from './threshold-tuner.js';
import { runPatternDiscovery } from './pattern-discoverer.js';
import { ANALYST_DEADLINE_MS, BATCH_DEADLINE_MS } from './constants.js';

const log = createLogger('analyst:scheduler');

const BATCH_SCHEDULE = process.env.ANALYST_BATCH_SCHEDULE || '0 2 * * *';

let cronTask = null;

// ── Per-incident dedup guard ────────────────────────────────
const recentlyAnalyzed = new Map();
const DEDUP_TTL_MS = 60_000;

/**
 * Race a promise against a deadline timer.
 *
 * @param {Function} fn - Async function to execute
 * @param {number} deadlineMs - Timeout in milliseconds
 * @param {string} label - Label for timeout error message
 * @returns {Promise<*>} Result of fn()
 * @throws {Error} If deadline is reached before fn completes
 */
function raceDeadline(fn, deadlineMs, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded deadline of ${deadlineMs}ms`)), deadlineMs);
  });
  return Promise.race([fn(), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Reject cron expressions that run more frequently than every 5 minutes.
 *
 * @param {string} cronExpr
 * @returns {boolean} True if the expression would fire too often
 */
function isTooFrequent(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const minuteField = parts[0];
  if (minuteField === '*') return true;
  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch && parseInt(stepMatch[1], 10) < 5) return true;
  return false;
}

/**
 * Analyze a single incident after it reaches a terminal state.
 *
 * Runs retrospective (always) and runbook generation (eligibility checked
 * internally). Each function has independent error handling — a retrospective
 * failure does not block runbook generation.
 *
 * Includes an in-memory dedup guard: if the same incident is analyzed twice
 * within 60s (e.g. from a state machine race), the second call is skipped.
 *
 * This function is designed to be called via fire-and-forget from the
 * state machine. It must never throw — all errors are caught and logged.
 *
 * @param {string} incidentId - The incident document ID
 * @param {string} terminalState - The terminal state (resolved, escalated, suppressed)
 * @param {object} incidentData - Full incident document from vigil-incidents
 * @param {object} [options]
 * @param {number} [options.deadlineMs] - Override deadline for testing
 */
export async function analyzeIncident(incidentId, terminalState, incidentData, options = {}) {
  const now = Date.now();

  // Dedup: skip if already analyzed within TTL window
  if (recentlyAnalyzed.has(incidentId) && (now - recentlyAnalyzed.get(incidentId)) < DEDUP_TTL_MS) {
    log.info(`${incidentId}: already analyzed within ${DEDUP_TTL_MS}ms — skipping`);
    return;
  }
  recentlyAnalyzed.set(incidentId, now);

  // Periodically clean stale entries
  for (const [id, ts] of recentlyAnalyzed) {
    if (now - ts > DEDUP_TTL_MS) recentlyAnalyzed.delete(id);
  }

  log.info(`Starting per-incident analysis for ${incidentId} (${terminalState})`);
  const startTime = Date.now();
  const deadlineMs = options.deadlineMs ?? ANALYST_DEADLINE_MS;

  try {
    await raceDeadline(
      async () => {
        // 1. Retrospective — always runs for every terminal incident
        try {
          await runRetrospective(incidentData);
        } catch (err) {
          log.error(`Retrospective failed for ${incidentId}: ${err.stack || err.message}`);
        }

        // 2. Runbook generation — eligibility checked internally
        try {
          await runRunbookGeneration(incidentData);
        } catch (err) {
          log.error(`Runbook generation failed for ${incidentId}: ${err.stack || err.message}`);
        }
      },
      deadlineMs,
      `Per-incident analysis for ${incidentId}`
    );
  } catch (err) {
    log.error(`Per-incident analysis aborted for ${incidentId}: ${err.stack || err.message}`);
  }

  const elapsed = Date.now() - startTime;
  log.info(`Per-incident analysis complete for ${incidentId}`, { elapsed_ms: elapsed, incident_id: incidentId });
}

/**
 * Run the daily batch analysis: weight calibration, threshold tuning,
 * and pattern discovery. Functions run in parallel via Promise.allSettled —
 * one failure/timeout does not block the others.
 *
 * @param {object} [options]
 * @param {number} [options.deadlineMs] - Override per-function deadline for testing
 */
export async function runBatchAnalysis(options = {}) {
  log.info('Starting daily batch analysis');
  const startTime = Date.now();
  const deadlineMs = options.deadlineMs ?? BATCH_DEADLINE_MS;

  const batchFunctions = [
    { name: 'Weight calibration', fn: () => runWeightCalibration({ window: '30d' }) },
    { name: 'Threshold tuning', fn: () => runThresholdTuning({ window: '14d' }) },
    { name: 'Pattern discovery', fn: () => runPatternDiscovery({ window: '90d' }) }
  ];

  const results = await Promise.allSettled(
    batchFunctions.map(({ name, fn }) => raceDeadline(fn, deadlineMs, name))
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      log.error(`${batchFunctions[i].name} failed: ${results[i].reason?.stack || results[i].reason?.message}`);
    }
  }

  const elapsed = Date.now() - startTime;
  const functionsFailed = results.filter(r => r.status === 'rejected').length;

  log.info('Daily batch analysis complete', { elapsed_ms: elapsed });

  // Write batch status record for operator monitoring
  try {
    await client.index({
      index: 'vigil-analyst-status',
      document: {
        '@timestamp': new Date().toISOString(),
        batch_type: 'daily_analysis',
        elapsed_ms: elapsed,
        functions_run: batchFunctions.length,
        functions_failed: functionsFailed,
        schedule: BATCH_SCHEDULE
      }
    });
  } catch (err) {
    log.warn(`Failed to write batch status record: ${err.message}`);
  }
}

/**
 * Start the daily batch scheduler using node-cron.
 *
 * Defaults to '0 2 * * *' (daily at 02:00 UTC). Configurable via
 * ANALYST_BATCH_SCHEDULE environment variable.
 */
export function startBatchScheduler() {
  if (cronTask) {
    log.warn('Batch scheduler already running — stopping previous instance');
    cronTask.stop();
  }

  if (!cron.validate(BATCH_SCHEDULE)) {
    log.error(`Invalid cron expression: '${BATCH_SCHEDULE}'. Batch scheduler not started.`);
    return;
  }

  if (isTooFrequent(BATCH_SCHEDULE)) {
    log.error(`Cron expression '${BATCH_SCHEDULE}' fires more often than every 5 minutes — refusing to start. This would overwhelm Elasticsearch.`);
    return;
  }

  cronTask = cron.schedule(BATCH_SCHEDULE, () => {
    runBatchAnalysis().catch(err => {
      log.error(`Unhandled error in batch analysis: ${err.stack || err.message}`);
    });
  }, {
    timezone: 'UTC'
  });

  log.info(`Batch scheduler started: '${BATCH_SCHEDULE}' (UTC)`);
}

/**
 * Stop the batch scheduler and release the cron task reference.
 */
export function stopBatchScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    log.info('Batch scheduler stopped');
  }
}
