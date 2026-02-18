// Change Correlator — joins deployment events with error spikes
// to identify whether a recent code change caused an operational incident.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('investigator-change-correlator');

// Column names match the LOOKUP JOIN query and the fallback at
// src/tools/esql/change-correlation-fallback.js:25-34
const EXPECTED_COLUMNS = [
  'service.name', 'error_count', 'commit.sha', 'commit.message',
  'commit.author', 'pr.number', 'time_gap_seconds', 'deployment.previous_sha'
];

/**
 * Build a column-name-to-index map from ES|QL columnar results.
 */
function buildColIndex(columns) {
  const idx = {};
  columns.forEach((col, i) => { idx[col.name] = i; });
  return idx;
}

/**
 * Compute confidence level from time gap between deployment and first error.
 *
 * @param {number} gapSeconds
 * @returns {'high'|'medium'|'low'}
 */
function gapToConfidence(gapSeconds) {
  if (gapSeconds < 300) return 'high';
  if (gapSeconds <= 600) return 'medium';
  return 'low';
}

/**
 * Correlate recent deployments with error spikes using the
 * vigil-esql-change-correlation tool (LOOKUP JOIN with fallback).
 *
 * @param {number} [maxGapSeconds=600] - Maximum gap between deployment and first error
 * @returns {Promise<{matched: boolean, service_name: string|null, commit_sha: string|null,
 *   commit_author: string|null, pr_number: number|null, time_gap_seconds: number|null,
 *   confidence: string|null}>}
 */
export async function correlateChanges(maxGapSeconds = 3600) {
  const noMatch = {
    matched: false,
    service_name: null,
    commit_sha: null,
    commit_author: null,
    pr_number: null,
    time_gap_seconds: null,
    confidence: null
  };

  try {
    const result = await executeEsqlTool('vigil-esql-change-correlation', {
      max_gap_seconds: maxGapSeconds
    });

    if (!result?.values?.length || !result?.columns?.length) {
      log.info('Change correlation returned no results');
      return noMatch;
    }

    const col = buildColIndex(result.columns);

    // Warn on missing expected columns
    for (const expected of EXPECTED_COLUMNS) {
      if (col[expected] === undefined) {
        log.warn(`change-correlation: expected column '${expected}' not found (columns: ${result.columns.map(c => c.name).join(', ')})`);
      }
    }

    // First row is the closest match (sorted by time_gap_seconds ASC)
    const row = result.values[0];
    const timeGap = row[col['time_gap_seconds']] ?? null;

    return {
      matched: true,
      service_name: row[col['service.name']] ?? null,
      commit_sha: row[col['commit.sha']] ?? null,
      commit_author: row[col['commit.author']] ?? null,
      pr_number: row[col['pr.number']] ?? null,
      time_gap_seconds: timeGap,
      confidence: timeGap !== null ? gapToConfidence(timeGap) : null
    };
  } catch (err) {
    log.error(`Change correlation failed: ${err.message}`);
    return noMatch;
  }
}
