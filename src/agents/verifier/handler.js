// Verifier Agent A2A request handler.
// Receives verify_resolution requests from vigil-coordinator, waits for
// metric stabilization, compares live health data against baselines and
// success criteria (dual comparison), and returns a pass/fail verdict
// with failure analysis.
//
// Timing budget (A2A timeout = 120s):
//   getIncidentIteration:  ~1s
//   waitForStabilization:  10s   (default; override via VIGIL_STABILIZATION_WAIT_SECONDS)
//   health check deadline: 50s   (default, covers parallel I/O)
//   buffer:                ~59s
// Total: ~120s. The deadline covers only the I/O phase.
//
// Verification results are NOT indexed here — the Coordinator stores the
// full A2A response into vigil-incidents.verification_results at
// delegation.js:447. Duplicating that write here would create mixed-schema
// entries in the array.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { executeSearchTool } from '../../tools/search/executor.js';
import { validateVerifyResponse } from '../../a2a/contracts.js';
import { computeHealthScore, evaluateCriterion } from './health-scorer.js';
import { waitForStabilization } from './stabilization.js';
import { buildFailureAnalysis } from './failure-analyzer.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('verifier-handler');

// --- Configuration ---
// VERIFICATION_DEADLINE_MS covers only the health check I/O phase (after
// stabilization). Must satisfy: stabilization + deadline + buffer < 120s A2A.
// With 60s stabilization: 60 + 50 + 10 = 120s.

const VERIFICATION_DEADLINE_MS =
  parseInt(process.env.VIGIL_VERIFICATION_DEADLINE_MS, 10) || 50_000;

// Re-read on each call so scenarios can adjust at runtime
function getStabilizationWaitSeconds() {
  return parseInt(process.env.VIGIL_STABILIZATION_WAIT_SECONDS, 10) || 10;
}

const HEALTH_SCORE_THRESHOLD =
  parseFloat(process.env.VIGIL_HEALTH_SCORE_THRESHOLD || '0.8');

// --- ES|QL Result Helpers ---

/**
 * Build a column-name-to-index map from ES|QL columnar results.
 */
function buildColIndex(columns, expectedCols, toolLabel) {
  const idx = {};
  columns.forEach((col, i) => { idx[col.name] = i; });

  for (const expected of expectedCols) {
    if (idx[expected] === undefined) {
      log.warn(`${toolLabel}: expected column '${expected}' not found`, {
        expected,
        actual_columns: columns.map(c => c.name)
      });
    }
  }
  return idx;
}

/**
 * Parse ES|QL columnar health comparison result into a metrics object.
 * Extracts both current metric values and baseline verdict booleans
 * for dual comparison (threshold AND baseline must both pass).
 *
 * @param {{ columns: Array, values: Array }} result
 * @returns {object|null} Health metrics including baseline verdict columns
 */
function extractHealthMetrics(result) {
  if (!result?.values?.length || !result?.columns?.length) return null;

  const col = buildColIndex(
    result.columns,
    [
      'service.name', 'current_avg_latency', 'current_error_rate',
      'current_throughput', 'current_cpu', 'current_memory',
      'latency_within_baseline', 'error_rate_acceptable', 'throughput_recovered'
    ],
    'health-comparison'
  );

  const row = result.values[0];
  return {
    avg_latency: row[col['current_avg_latency']] ?? null,
    error_rate: row[col['current_error_rate']] ?? null,
    throughput: row[col['current_throughput']] ?? null,
    cpu: row[col['current_cpu']] ?? null,
    memory: row[col['current_memory']] ?? null,
    // Baseline verdict columns — used by evaluateCriterion for dual comparison
    latency_within_baseline: row[col['latency_within_baseline']] ?? null,
    error_rate_acceptable: row[col['error_rate_acceptable']] ?? null,
    throughput_recovered: row[col['throughput_recovered']] ?? null
  };
}

/**
 * Find the threshold value for a specific metric and service from
 * the success criteria array.
 *
 * @param {Array} criteria - success_criteria from the request
 * @param {string} serviceName - Service to match
 * @param {string} metricName - Metric to find
 * @returns {number|undefined}
 */
function findThreshold(criteria, serviceName, metricName) {
  const match = criteria.find(
    c => c.service_name === serviceName && c.metric === metricName
  );
  return match?.threshold;
}

/**
 * Retrieve the current iteration number from the incident document.
 * Falls back to 1 if the incident cannot be read.
 *
 * @param {string} incidentId
 * @returns {Promise<number>}
 */
async function getIncidentIteration(incidentId) {
  try {
    const doc = await client.get({ index: 'vigil-incidents', id: incidentId });
    const reflectionCount = doc._source?.reflection_count || 0;
    return reflectionCount + 1;
  } catch (err) {
    log.warn(`Failed to read incident ${incidentId} for iteration count: ${err.message}`);
    return 1;
  }
}

// --- Request Validation ---

const VALID_OPERATORS = new Set(['lte', 'gte', 'eq']);

/**
 * Validate the incoming verify_resolution request envelope.
 * Throws on invalid input — matches the commander validation pattern.
 *
 * @param {object} envelope
 */
function validateRequest(envelope) {
  if (envelope.task !== 'verify_resolution') {
    throw new Error(
      `Verifier received unknown task: '${envelope.task}' (expected 'verify_resolution')`
    );
  }

  if (!envelope.incident_id) {
    throw new Error('Verifier request missing required field: incident_id');
  }

  if (!Array.isArray(envelope.affected_services) || envelope.affected_services.length === 0) {
    throw new Error('Verifier request missing required field: affected_services');
  }

  if (!Array.isArray(envelope.success_criteria) || envelope.success_criteria.length === 0) {
    throw new Error('Verifier request missing required field: success_criteria (empty array)');
  }

  for (const criterion of envelope.success_criteria) {
    if (!criterion.metric || typeof criterion.metric !== 'string') {
      throw new Error('Invalid criterion: metric must be a non-empty string');
    }
    if (!VALID_OPERATORS.has(criterion.operator)) {
      throw new Error(
        `Invalid operator '${criterion.operator}' in criterion for ${criterion.metric}. ` +
        'Must be one of: lte, gte, eq'
      );
    }
    if (typeof criterion.threshold !== 'number') {
      throw new Error(`Invalid criterion: threshold must be a number for ${criterion.metric}`);
    }
    if (!criterion.service_name || typeof criterion.service_name !== 'string') {
      throw new Error(`Invalid criterion: service_name must be a non-empty string for ${criterion.metric}`);
    }
  }
}

// --- Core Verification ---

/**
 * Run the health check pipeline (after stabilization): baseline
 * fetching, health comparison, criteria evaluation, and scoring.
 * Health comparison queries run in parallel per service.
 *
 * @param {object} envelope - Validated request
 * @returns {Promise<object>} Partial response (without iteration)
 */
async function runHealthChecks(envelope) {
  // 1. Fetch baselines for all affected services in parallel
  const baselinesByService = new Map();
  const baselinePromises = envelope.affected_services.map(async (service) => {
    try {
      const result = await executeSearchTool('vigil-search-baselines', service);
      baselinesByService.set(service, result.results || []);
    } catch (err) {
      log.warn(`Baseline fetch failed for ${service}: ${err.message}`);
      baselinesByService.set(service, []);
    }
  });
  await Promise.allSettled(baselinePromises);

  // 2. Run health comparison for each affected service (parallel)
  const healthDataByService = new Map();
  const healthCheckPromises = envelope.affected_services.map(async (service) => {
    const baselines = baselinesByService.get(service) || [];
    const avgLatencyBaseline = baselines.find(b => b.metric_name === 'avg_latency');

    const params = {
      service_name: service,
      baseline_avg: avgLatencyBaseline?.avg_value ?? 50000,
      baseline_stddev: avgLatencyBaseline?.stddev_value ?? 15000,
      max_error_rate: findThreshold(envelope.success_criteria, service, 'error_rate') ?? 5.0,
      min_throughput: findThreshold(envelope.success_criteria, service, 'throughput') ?? 10
    };

    try {
      const result = await executeEsqlTool('vigil-esql-health-comparison', params);
      healthDataByService.set(service, extractHealthMetrics(result));
    } catch (err) {
      log.warn(`Health check failed for ${service}: ${err.message}`);
      healthDataByService.set(service, null);
    }
  });
  await Promise.allSettled(healthCheckPromises);

  // 3. Evaluate each success criterion (dual comparison: threshold + baseline)
  const criteriaResults = envelope.success_criteria.map(criterion => {
    const healthData = healthDataByService.get(criterion.service_name) || null;
    return evaluateCriterion(criterion, healthData);
  });

  // 4. Compute health score and verdict
  const healthScore = computeHealthScore(criteriaResults);
  const passed = healthScore >= HEALTH_SCORE_THRESHOLD;

  // 5. Build failure analysis if needed
  const failureAnalysis = passed
    ? null
    : buildFailureAnalysis(criteriaResults, baselinesByService);

  return { healthScore, passed, criteriaResults, failureAnalysis };
}

// --- Request Handler ---

/**
 * A2A request handler for the Verifier agent.
 * Validates the incoming request, waits for stabilization, races the
 * health check pipeline against a deadline, and returns a validated
 * verification response.
 *
 * @param {object} envelope - Request from vigil-coordinator via buildVerifyRequest()
 * @param {object} [options] - Execution options
 * @param {number} [options.deadlineMs] - Override deadline for testing
 * @returns {Promise<object>} Validated verification response
 */
export async function handleVerifyRequest(envelope, options = {}) {
  // --- Validate request ---
  validateRequest(envelope);

  const startTime = Date.now();
  const deadlineMs = options.deadlineMs ?? VERIFICATION_DEADLINE_MS;

  log.info(`Verifying resolution for incident ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    affected_services: envelope.affected_services.length,
    success_criteria: envelope.success_criteria.length
  });

  // Fetch iteration BEFORE the race so it's available in both success
  // and degraded paths — prevents hardcoding iteration=1 on deadline failures
  // which would corrupt the Coordinator's reflection loop iteration cap.
  const iteration = await getIncidentIteration(envelope.incident_id);

  // Stabilization wait is mandatory — runs before the deadline race.
  // The deadline covers only the I/O-intensive health check phase.
  await waitForStabilization(getStabilizationWaitSeconds());

  let verificationResult;
  let deadlineHandle;

  try {
    // Race health checks against deadline to stay within A2A timeout.
    // Budget: 120s A2A - 60s stabilization - ~10s overhead = ~50s for I/O.
    const deadline = new Promise((_, reject) => {
      deadlineHandle = setTimeout(
        () => reject(new Error('Verification deadline exceeded')),
        deadlineMs
      );
    });

    verificationResult = await Promise.race([
      runHealthChecks(envelope),
      deadline
    ]);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log.error(`Verification failed for ${envelope.incident_id}: ${err.message}`, {
      incident_id: envelope.incident_id,
      error: err.message,
      elapsed_ms: elapsed
    });

    // Build failure analysis from the actual error — don't assume deadline
    const isDeadline = err.message.includes('deadline');
    const failureAnalysis = isDeadline
      ? `Verification deadline exceeded after ${elapsed}ms`
      : `Verification error: ${err.message}`;

    const degradedResponse = {
      incident_id: envelope.incident_id,
      iteration,
      health_score: 0,
      passed: false,
      criteria_results: [],
      failure_analysis: failureAnalysis
    };

    try {
      validateVerifyResponse(degradedResponse);
    } catch (validationErr) {
      log.error(`Degraded response failed self-validation: ${validationErr.message}`);
    }

    return degradedResponse;
  } finally {
    clearTimeout(deadlineHandle);
  }

  // Assemble response
  const response = {
    incident_id: envelope.incident_id,
    iteration,
    health_score: verificationResult.healthScore,
    passed: verificationResult.passed,
    criteria_results: verificationResult.criteriaResults,
    failure_analysis: verificationResult.failureAnalysis
  };

  // Self-validate before returning
  validateVerifyResponse(response);

  const elapsed = Date.now() - startTime;
  log.info(`Verifier completed for ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    health_score: response.health_score,
    passed: response.passed,
    criteria_evaluated: response.criteria_results.length,
    iteration: response.iteration,
    elapsed_ms: elapsed
  });

  return response;
}
