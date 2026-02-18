import { createLogger } from '../../utils/logger.js';

const log = createLogger('coordinator-timing');

export function diffSeconds(start, end) {
  if (!start || !end) return null;
  const diff = Math.floor((new Date(end) - new Date(start)) / 1000);
  if (isNaN(diff)) {
    log.warn(`Invalid timestamp pair: start=${start}, end=${end}`);
    return null;
  }
  return diff;
}

export function computeTimingMetrics(incidentDoc) {
  const ts = incidentDoc._state_timestamps || {};

  // TTD: alert_timestamp → detected
  const ttd = diffSeconds(
    incidentDoc.alert_timestamp,
    ts.detected
  );

  // TTI: investigating → investigation report received
  // Falls back to planning timestamp if _investigation_completed_at not set
  const tti = diffSeconds(
    ts.investigating,
    incidentDoc._investigation_completed_at || ts.planning
  );

  // TTR: executing → execution complete (verifying entry = execution end)
  const ttr = diffSeconds(
    ts.executing,
    ts.verifying
  );

  // TTV: verifying → resolved (final verification verdict)
  const ttv = diffSeconds(
    ts.verifying,
    ts.resolved
  );

  // Total: created_at → resolved_at
  const total = diffSeconds(
    incidentDoc.created_at,
    incidentDoc.resolved_at
  );

  const metrics = {
    ttd_seconds: ttd,
    tti_seconds: tti,
    ttr_seconds: ttr,
    ttv_seconds: ttv,
    total_duration_seconds: total
  };

  log.debug(`Computed timing metrics for ${incidentDoc.incident_id}: ${JSON.stringify(metrics)}`);

  return metrics;
}
