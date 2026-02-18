// Sentinel change detection module.
// Correlates recent deployments and config changes from github-events-*
// with detected anomalies using configurable confidence windows.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('sentinel-change');

// --- Configuration ---

const HIGH_CONFIDENCE_WINDOW_MINUTES =
  parseFloat(process.env.VIGIL_HIGH_CONFIDENCE_WINDOW_MINUTES) || 5;

// Derived window boundaries in seconds.
// The ES|QL change detector query uses a hardcoded 30-minute window (NOW() - 30m),
// so HIGH_CONFIDENCE_WINDOW_MINUTES should stay <= 5 for the confidence bands to
// align with the query's return set. Setting it higher causes the 'low' band to
// extend beyond the 30-minute query window, meaning no events would reach that band.
const HIGH_WINDOW_SEC = HIGH_CONFIDENCE_WINDOW_MINUTES * 60;       // default: 300s  (5min)
const MEDIUM_WINDOW_SEC = HIGH_CONFIDENCE_WINDOW_MINUTES * 3 * 60; // default: 900s  (15min)
const LOW_WINDOW_SEC = HIGH_CONFIDENCE_WINDOW_MINUTES * 6 * 60;    // default: 1800s (30min)

// --- ES|QL Result Helpers ---

/**
 * Build a column-name-to-index map from ES|QL columnar results.
 */
function buildColIndex(columns, expectedCols, toolLabel) {
  const idx = {};
  columns.forEach((col, i) => { idx[col.name] = i; });

  for (const expected of expectedCols) {
    if (idx[expected] === undefined) {
      log.warn(`${toolLabel}: expected column '${expected}' not found (columns: ${columns.map(c => c.name).join(', ')})`);
    }
  }
  return idx;
}

// --- Confidence Mapping ---

/**
 * Map a time gap (in seconds) to a confidence level.
 *
 * Windows (configurable via VIGIL_HIGH_CONFIDENCE_WINDOW_MINUTES):
 *   < high_window (5min default)   → high
 *   < medium_window (15min default) → medium
 *   < low_window (30min default)    → low
 *   >= low_window                   → none
 *
 * @param {number} gapSeconds - Time gap between change event and anomaly detection
 * @returns {string} Confidence level: 'high' | 'medium' | 'low' | 'none'
 */
function gapToConfidence(gapSeconds) {
  const absGap = Math.abs(gapSeconds);
  if (absGap < HIGH_WINDOW_SEC) return 'high';
  if (absGap < MEDIUM_WINDOW_SEC) return 'medium';
  if (absGap < LOW_WINDOW_SEC) return 'low';
  return 'none';
}

// --- Public API ---

/**
 * Detect recent changes (deployments, pushes, config changes) for a service
 * and compute temporal correlation with the anomaly detection time.
 *
 * @param {string} serviceName - Service to check for recent changes
 * @param {string} [anomalyDetectedAt] - ISO timestamp of anomaly detection (defaults to now)
 * @returns {Promise<{deployment_found: boolean, events: Array, closest_event: object|null}>}
 */
export async function detectRecentChanges(serviceName, anomalyDetectedAt) {
  const anomalyTime = anomalyDetectedAt
    ? new Date(anomalyDetectedAt).getTime()
    : Date.now();

  log.info(`Checking recent changes for '${serviceName}'`);

  try {
    const result = await executeEsqlTool('vigil-esql-recent-change-detector', {
      service_name: serviceName
    });

    if (!result?.values?.length || !result?.columns?.length) {
      log.info(`No recent changes found for '${serviceName}'`);
      return {
        deployment_found: false,
        events: [],
        closest_event: null
      };
    }

    const col = buildColIndex(
      result.columns,
      ['@timestamp', 'event_type', 'commit.sha', 'commit.message',
       'commit.author', 'pr.number', 'deployment.environment'],
      'recent-change-detector'
    );

    const events = result.values.map(row => {
      const eventTimestamp = row[col['@timestamp']] ?? null;
      const eventTime = eventTimestamp ? new Date(eventTimestamp).getTime() : 0;
      const timeGapSeconds = Math.round((anomalyTime - eventTime) / 1000);

      return {
        timestamp: eventTimestamp,
        event_type: row[col['event_type']] ?? 'unknown',
        commit_sha: row[col['commit.sha']] ?? null,
        commit_message: row[col['commit.message']] ?? null,
        commit_author: row[col['commit.author']] ?? null,
        pr_number: row[col['pr.number']] ?? null,
        deployment_environment: row[col['deployment.environment']] ?? null,
        time_gap_seconds: timeGapSeconds,
        confidence: gapToConfidence(timeGapSeconds)
      };
    });

    // Find the closest event (smallest absolute time gap)
    const closestEvent = events.reduce((closest, event) => {
      if (!closest) return event;
      return Math.abs(event.time_gap_seconds) < Math.abs(closest.time_gap_seconds)
        ? event
        : closest;
    }, null);

    // Only flag deployment_found when at least one event has meaningful
    // confidence. Events with confidence 'none' are outside the correlation
    // window and should not be treated as correlated deployments.
    const deploymentFound = events.some(e => e.confidence !== 'none');

    log.info(
      `Found ${events.length} change event(s) for '${serviceName}'` +
      (closestEvent
        ? ` — closest: ${closestEvent.event_type} at ${closestEvent.time_gap_seconds}s gap (${closestEvent.confidence} confidence)`
        : '')
    );

    return {
      deployment_found: deploymentFound,
      events,
      closest_event: closestEvent
    };
  } catch (err) {
    log.warn(`Change detection failed for '${serviceName}': ${err.message}`);
    return {
      deployment_found: false,
      events: [],
      closest_event: null
    };
  }
}
