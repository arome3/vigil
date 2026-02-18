// Threat Scope Report Builder — pure function module (no I/O except logging).
// Categorizes scanned assets into confirmed_compromised, suspected_compromised,
// and clean_assets for the Coordinator and Commander.

import { createLogger } from '../../utils/logger.js';

const log = createLogger('threat-hunter-scope-report');

/**
 * Build the three-tier threat scope report from IoC sweep hits and
 * behavioral anomaly detections.
 *
 * @param {Array<{host: string, sourceIp: string, hitCount: number,
 *   uniqueIndicators: number, firstContact: string|null,
 *   lastContact: string|null}>} iocHits
 *   Rows from the vigil-esql-ioc-sweep result.
 *
 * @param {Array<{userName: string, loginCount: number, uniqueIps: number,
 *   uniqueGeos: number, offHoursLogins: number, failedRatio: number,
 *   anomalyScore: number}>} anomalies
 *   Rows from the vigil-esql-behavioral-anomaly result(s).
 *
 * @param {number} totalAssetsFromCount
 *   Total distinct hosts from the environment-wide count query.
 *
 * @returns {{ confirmed_compromised: Array, suspected_compromised: Array,
 *   total_assets_scanned: number, clean_assets: number }}
 */
export function buildScopeReport(iocHits, anomalies, totalAssetsFromCount) {
  const confirmed = buildConfirmedCompromised(iocHits);
  const suspected = buildSuspectedCompromised(anomalies);

  // total_assets_scanned is at least the count query result, but never less
  // than the number of assets we actually found evidence for.
  const totalAssetsScanned = Math.max(
    totalAssetsFromCount || 0,
    confirmed.length + suspected.length
  );

  // Note: confirmed entries are host-based (from IoC sweep grouped by host.name)
  // while suspected entries are user-based (from behavioral anomaly grouped by
  // user.name). The subtraction mixes units, but the spec example at
  // docs/08-agent-threat-hunter.md:284-286 uses this exact calculation
  // (247 total - 2 confirmed - 1 suspected = 244 clean).
  const cleanAssets = Math.max(0, totalAssetsScanned - confirmed.length - suspected.length);

  log.info(
    `Scope report: ${confirmed.length} confirmed, ${suspected.length} suspected, ` +
    `${cleanAssets} clean out of ${totalAssetsScanned} scanned`
  );

  return {
    confirmed_compromised: confirmed,
    suspected_compromised: suspected,
    total_assets_scanned: totalAssetsScanned,
    clean_assets: cleanAssets
  };
}

/**
 * Group IoC hits by host.name and build confirmed_compromised entries.
 * A single host can appear in multiple rows with different source.ip values.
 *
 * Output satisfies delegation.js:84-86 which iterates
 * confirmed_compromised[].asset_id.
 *
 * @param {Array} iocHits
 * @returns {Array<{asset_id: string, host: string, indicators_matched: string[]}>}
 */
function buildConfirmedCompromised(iocHits) {
  if (!iocHits?.length) return [];

  // Group by host.name — each host may have multiple source.ip rows
  const hostMap = new Map();

  for (const hit of iocHits) {
    const host = hit.host || 'unknown';
    if (!hostMap.has(host)) {
      hostMap.set(host, { totalHitCount: 0, indicators: [] });
    }

    const entry = hostMap.get(host);
    entry.totalHitCount += hit.hitCount || 0;

    const descriptor = formatIndicatorDescriptor(hit);
    if (descriptor) {
      entry.indicators.push(descriptor);
    }
  }

  // Sort by total hit count descending
  const sorted = [...hostMap.entries()]
    .sort((a, b) => b[1].totalHitCount - a[1].totalHitCount);

  return sorted.map(([host, data]) => ({
    asset_id: host,
    host,
    indicators_matched: data.indicators
  }));
}

/**
 * Format a single IoC hit row into a human-readable indicator descriptor.
 *
 * @param {object} hit - Single IoC hit row
 * @returns {string} e.g. "10.0.0.5 (23 connections, first: 2026-02-10T...)"
 */
function formatIndicatorDescriptor(hit) {
  const parts = [];

  if (hit.sourceIp) {
    parts.push(hit.sourceIp);
  }

  const details = [];
  if (hit.hitCount) {
    details.push(`${hit.hitCount} connections`);
  }
  if (hit.firstContact) {
    details.push(`first: ${hit.firstContact}`);
  }

  if (parts.length === 0 && details.length === 0) return null;

  const base = parts.join(', ') || 'unknown';
  return details.length > 0 ? `${base} (${details.join(', ')})` : base;
}

/**
 * Build suspected_compromised entries from behavioral anomaly detections.
 * Sorted by anomaly_score descending.
 *
 * @param {Array} anomalies
 * @returns {Array<{asset_id: string, host: string, anomaly_score: number, reason: string}>}
 */
function buildSuspectedCompromised(anomalies) {
  if (!anomalies?.length) return [];

  return anomalies
    .sort((a, b) => b.anomalyScore - a.anomalyScore)
    .map(a => ({
      asset_id: a.userName,
      host: a.userName,
      anomaly_score: a.anomalyScore,
      reason: formatAnomalyReason(a)
    }));
}

/**
 * Format a human-readable reason string for a behavioral anomaly.
 *
 * @param {object} anomaly
 * @returns {string} e.g. "User admin: 4 geo locations, 12 off-hours logins, 35% failed auth ratio"
 */
function formatAnomalyReason(anomaly) {
  const parts = [];

  if (anomaly.uniqueGeos != null) {
    parts.push(`${anomaly.uniqueGeos} geo locations`);
  }
  if (anomaly.offHoursLogins != null) {
    parts.push(`${anomaly.offHoursLogins} off-hours logins`);
  }
  if (anomaly.failedRatio != null) {
    parts.push(`${Math.round(anomaly.failedRatio * 100)}% failed auth ratio`);
  }

  return `User ${anomaly.userName}: ${parts.join(', ')}`;
}
