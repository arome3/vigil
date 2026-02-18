// Sentinel Agent A2A request handler.
// Dual-mode routing: continuous monitoring (monitor_health) and
// on-demand health queries (get_health_metrics) for the Verifier.

import { v4 as uuidv4 } from 'uuid';
import { monitorAllServices, checkServiceHealth } from './anomaly-detector.js';
import { traceDependencies } from './dependency-tracer.js';
import { detectRecentChanges } from './change-detector.js';
import { sendA2AMessage } from '../../a2a/router.js';
import { createEnvelope } from '../../a2a/message-envelope.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('sentinel-handler');

// --- Configuration ---

const MONITORING_DEADLINE_MS =
  parseInt(process.env.VIGIL_MONITORING_DEADLINE_MS, 10) || 120_000;

// --- Asset Tier Lookup ---

/**
 * Look up asset criticality tier for a service from vigil-assets.
 * Returns 'tier-2' as default if lookup fails or no data found.
 *
 * @param {string} serviceName - Service to look up
 * @returns {Promise<string>} Tier string ('tier-1', 'tier-2', 'tier-3')
 */
async function lookupServiceTier(serviceName) {
  try {
    const result = await client.search({
      index: 'vigil-assets',
      query: { term: { 'asset_id': serviceName } },
      size: 1,
      _source: { includes: ['criticality'] }
    });
    const hit = result.hits?.hits?.[0];
    return hit?._source?.criticality || 'tier-2';
  } catch (err) {
    log.warn(`Asset tier lookup failed for '${serviceName}': ${err.message}`);
    return 'tier-2';
  }
}

// --- Anomaly Report Builder ---

/**
 * Build a structured anomaly report compatible with
 * coordinator/delegation.js:280 orchestrateOperationalIncident().
 *
 * Critical fields consumed by the coordinator:
 *   anomaly_id       → triageLike.alert_id (line 285)
 *   detected_at      → triageLike.alert_timestamp (line 292)
 *   affected_service_tier → asset_criticality (line 290)
 *   change_correlation.confidence → high-confidence routing check (line 301)
 *   change_correlation.commit_author → source_user (line 305)
 *   affected_assets[] → passed to executeFromPlanning (line 343)
 *   root_cause_assessment → fallback root cause text (line 331) — MUST be a string
 *
 * @param {object} anomaly - Anomaly object from monitorAllServices()
 * @param {object} rootCauseAssessment - Result from traceDependencies()
 * @param {object} changeCorrelation - Result from detectRecentChanges()
 * @param {string} serviceTier - Asset criticality tier from vigil-assets
 * @returns {object} Structured anomaly report
 */
function buildAnomalyReport(anomaly, rootCauseAssessment, changeCorrelation, serviceTier) {
  const anomalyId = `ANOM-${uuidv4().slice(0, 8).toUpperCase()}`;

  // Build affected_assets list — always includes the primary service,
  // plus the root cause service if it differs
  const affectedAssets = [anomaly.service_name];
  if (rootCauseAssessment.root_cause_service &&
      rootCauseAssessment.root_cause_service !== anomaly.service_name) {
    affectedAssets.push(rootCauseAssessment.root_cause_service);
  }

  // Build change_correlation in the shape coordinator expects
  const changeCorr = changeCorrelation.deployment_found && changeCorrelation.closest_event
    ? {
        deployment_found: true,
        commit_sha: changeCorrelation.closest_event.commit_sha,
        commit_author: changeCorrelation.closest_event.commit_author,
        commit_message: changeCorrelation.closest_event.commit_message,
        pr_number: changeCorrelation.closest_event.pr_number,
        deployment_environment: changeCorrelation.closest_event.deployment_environment,
        time_gap_seconds: changeCorrelation.closest_event.time_gap_seconds,
        confidence: changeCorrelation.closest_event.confidence
      }
    : {
        deployment_found: false,
        confidence: 'none'
      };

  // root_cause_assessment MUST be a string — delegation.js:331 assigns it
  // directly to the synthetic investigator response's root_cause field,
  // which contracts.js:109 validates as typeof string.
  const rootCauseText = rootCauseAssessment.reasoning ||
    `Anomaly detected in ${anomaly.service_name}: ${anomaly.anomaly_type}`;

  return {
    type: 'anomaly_report',
    anomaly_id: anomalyId,
    detected_at: anomaly.detected_at,
    affected_service: anomaly.service_name,
    affected_service_tier: serviceTier,
    anomaly_type: anomaly.anomaly_type,
    metric_deviations: anomaly.metric_deviations,
    root_cause_assessment: rootCauseText,
    root_cause_details: {
      is_root_cause: rootCauseAssessment.is_root_cause,
      confidence: rootCauseAssessment.confidence,
      reasoning: rootCauseAssessment.reasoning,
      root_cause_service: rootCauseAssessment.root_cause_service
    },
    change_correlation: changeCorr,
    affected_assets: affectedAssets
  };
}

// --- Index Anomaly Report ---

/**
 * Index an anomaly report to vigil-alerts-operational (fire-and-forget).
 * Follows the same pattern as investigator/handler.js:indexReport().
 *
 * @param {object} report - Structured anomaly report
 */
async function indexAnomalyReport(report) {
  try {
    await client.index({
      index: 'vigil-alerts-operational',
      id: report.anomaly_id,
      document: {
        ...report,
        '@timestamp': new Date().toISOString()
      },
      refresh: false
    });
    log.info(`Indexed anomaly report ${report.anomaly_id}`);
  } catch (err) {
    log.warn(`Failed to index anomaly report ${report.anomaly_id}: ${err.message}`);
  }
}

// --- Forward Report to Coordinator ---

/**
 * Forward an anomaly report to the coordinator via A2A message.
 * The coordinator's orchestrateOperationalIncident() consumes these.
 *
 * @param {object} report - Structured anomaly report
 */
async function forwardToCoordinator(report) {
  try {
    const envelope = createEnvelope(
      'vigil-sentinel',
      'vigil-coordinator',
      report.anomaly_id,
      {
        task: 'operational_incident',
        sentinel_report: report
      }
    );
    await sendA2AMessage('vigil-coordinator', envelope);
    log.info(`Forwarded anomaly report ${report.anomaly_id} to coordinator`);
  } catch (err) {
    log.warn(`Failed to forward ${report.anomaly_id} to coordinator: ${err.message}`);
  }
}

// --- Continuous Monitoring Pipeline ---

/**
 * Run the full monitoring pipeline:
 * 1. Discover and check all services
 * 2. For each anomaly: trace dependencies + detect changes + lookup tier (in parallel)
 * 3. Build anomaly reports
 * 4. Index reports + forward to coordinator (fire-and-forget)
 *
 * @returns {Promise<object>} Pipeline results
 */
async function runMonitoringPipeline() {
  const startTime = Date.now();
  const monitoringResult = await monitorAllServices();

  if (monitoringResult.anomalies.length === 0) {
    log.info('No anomalies detected — all services healthy');
    return {
      status: 'healthy',
      ...monitoringResult,
      reports: [],
      elapsed_ms: Date.now() - startTime
    };
  }

  // Collect all anomalous service names for cross-referencing in dependency tracing
  const allAnomalousServices = monitoringResult.anomalies.map(a => a.service_name);

  // Enrich all anomalies in parallel: trace deps + detect changes + lookup tier
  const enrichmentResults = await Promise.allSettled(
    monitoringResult.anomalies.map(async (anomaly) => {
      const otherAnomalous = allAnomalousServices.filter(s => s !== anomaly.service_name);

      const [traceResult, changeResult, tierResult] = await Promise.allSettled([
        traceDependencies(anomaly.service_name, otherAnomalous),
        detectRecentChanges(anomaly.service_name, anomaly.detected_at),
        lookupServiceTier(anomaly.service_name)
      ]);

      const rootCauseAssessment = traceResult.status === 'fulfilled'
        ? traceResult.value
        : {
            is_root_cause: true,
            confidence: 'low',
            reasoning: `Dependency tracing failed: ${traceResult.reason?.message}`,
            root_cause_service: anomaly.service_name,
            failing_dependencies: [],
            dependencies: []
          };

      if (traceResult.status === 'rejected') {
        log.warn(`Dependency tracing failed for '${anomaly.service_name}': ${traceResult.reason?.message}`);
      }

      const changeCorrelation = changeResult.status === 'fulfilled'
        ? changeResult.value
        : { deployment_found: false, events: [], closest_event: null };

      if (changeResult.status === 'rejected') {
        log.warn(`Change detection failed for '${anomaly.service_name}': ${changeResult.reason?.message}`);
      }

      const serviceTier = tierResult.status === 'fulfilled' ? tierResult.value : 'tier-2';

      return buildAnomalyReport(anomaly, rootCauseAssessment, changeCorrelation, serviceTier);
    })
  );

  // Collect successful reports
  const reports = [];
  for (const result of enrichmentResults) {
    if (result.status === 'fulfilled') {
      reports.push(result.value);
    } else {
      log.warn(`Anomaly enrichment failed: ${result.reason?.message}`);
    }
  }

  // Fire-and-forget: index and forward each report to coordinator
  for (const report of reports) {
    indexAnomalyReport(report).catch(err => {
      log.warn(`Background index failed for ${report.anomaly_id}: ${err.message}`);
    });
    forwardToCoordinator(report).catch(err => {
      log.warn(`Background forward failed for ${report.anomaly_id}: ${err.message}`);
    });
  }

  const elapsed = Date.now() - startTime;
  log.info(`Monitoring pipeline complete: ${reports.length} report(s), elapsed=${elapsed}ms`);

  if (elapsed > MONITORING_DEADLINE_MS) {
    log.warn(`Monitoring pipeline took ${elapsed}ms, exceeding ${MONITORING_DEADLINE_MS}ms deadline`);
  }

  return {
    status: 'anomalies_detected',
    anomalies: monitoringResult.anomalies,
    healthy_services: monitoringResult.healthy_services,
    monitored_services: monitoringResult.monitored_services,
    reports,
    checked_at: monitoringResult.checked_at,
    elapsed_ms: elapsed
  };
}

// --- Main Handler ---

/**
 * Handle a Sentinel A2A request.
 *
 * Routing:
 *   task='monitor_health'     → Full pipeline: detect anomalies, trace deps,
 *                                correlate changes, build reports, forward to coordinator
 *   task='get_health_metrics' → On-demand: return raw metrics for a single service
 *
 * @param {object} envelope - A2A request envelope
 * @param {string} envelope.task - 'monitor_health' or 'get_health_metrics'
 * @param {string} [envelope.service_name] - Required for 'get_health_metrics'
 * @returns {Promise<object>} Task-appropriate response
 */
export async function handleSentinelRequest(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid request: envelope must be a non-null object');
  }
  if (!envelope.task || typeof envelope.task !== 'string') {
    throw new Error('Missing required field: task (must be a string)');
  }

  switch (envelope.task) {
    case 'monitor_health': {
      log.info('Starting continuous monitoring pipeline');

      // Race pipeline against deadline
      let deadlineHandle;
      const deadline = new Promise((_, reject) => {
        deadlineHandle = setTimeout(
          () => reject(new Error(`Monitoring deadline exceeded (${MONITORING_DEADLINE_MS}ms)`)),
          MONITORING_DEADLINE_MS
        );
      });

      try {
        const result = await Promise.race([runMonitoringPipeline(), deadline]);
        return result;
      } catch (err) {
        log.error(`Monitoring pipeline failed: ${err.message}`);
        return {
          status: 'error',
          error: err.message,
          anomalies: [],
          healthy_services: [],
          monitored_services: 0,
          reports: [],
          checked_at: new Date().toISOString(),
          elapsed_ms: MONITORING_DEADLINE_MS
        };
      } finally {
        clearTimeout(deadlineHandle);
      }
    }

    case 'get_health_metrics': {
      if (!envelope.service_name || typeof envelope.service_name !== 'string') {
        throw new Error("Task 'get_health_metrics' requires field: service_name (string)");
      }
      log.info(`On-demand health metrics request for '${envelope.service_name}'`);
      return checkServiceHealth(envelope.service_name);
    }

    default:
      throw new Error(`Unknown task: '${envelope.task}'. Expected 'monitor_health' or 'get_health_metrics'.`);
  }
}
