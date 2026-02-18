// Sentinel dependency tracer module.
// Traces upstream/downstream service dependencies via APM trace data to
// distinguish root cause services from downstream victims in cascading failures.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('sentinel-dependency');

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

// --- Dependency Extraction ---

/**
 * Extract dependency rows from the ES|QL dependency-tracer result.
 *
 * @param {{ columns: Array, values: Array }} result - ES|QL result
 * @returns {Array<{service_name: string, destination: string, call_count: number,
 *   avg_duration: number, error_count: number, error_rate: number}>}
 */
function extractDependencies(result) {
  if (!result?.values?.length || !result?.columns?.length) return [];

  const col = buildColIndex(
    result.columns,
    ['service.name', 'span.destination.service.resource', 'call_count',
     'avg_duration', 'error_count', 'error_rate'],
    'dependency-tracer'
  );

  return result.values.map(row => ({
    service_name: row[col['service.name']] ?? 'unknown',
    destination: row[col['span.destination.service.resource']] ?? 'unknown',
    call_count: row[col['call_count']] ?? 0,
    avg_duration: row[col['avg_duration']] ?? 0,
    error_count: row[col['error_count']] ?? 0,
    error_rate: row[col['error_rate']] ?? 0
  }));
}

// --- Root Cause Assessment ---

/**
 * Assess whether the anomalous service is the root cause or a downstream victim.
 *
 * Algorithm:
 *   1. Get outbound calls from the anomalous service
 *   2. Identify dependencies with >10% error rate
 *   3. Case A: No elevated outbound errors → service IS the root cause (high)
 *   4. Case B: Elevated errors to dependency X AND X is also anomalous → X is root cause (high)
 *   5. Case C: Elevated errors to X but X is NOT anomalous → service IS the root cause with
 *      bad outbound patterns (medium)
 *
 * @param {string} serviceName - The anomalous service
 * @param {Array} dependencies - Extracted dependency rows
 * @param {string[]} otherAnomalousServices - Other services currently flagged as anomalous
 * @returns {{ is_root_cause: boolean, confidence: string, reasoning: string,
 *   root_cause_service: string|null, failing_dependencies: Array }}
 */
function assessRootCause(serviceName, dependencies, otherAnomalousServices) {
  const anomalousSet = new Set(otherAnomalousServices);

  // Filter to outbound calls from the anomalous service
  const outbound = dependencies.filter(d => d.service_name === serviceName);

  // Identify dependencies with elevated error rates (>10%)
  const failingDeps = outbound.filter(d => d.error_rate > 10);

  // Case A: No elevated outbound errors → service IS the root cause
  if (failingDeps.length === 0) {
    return {
      is_root_cause: true,
      confidence: 'high',
      reasoning:
        `${serviceName} shows no elevated errors on its outbound dependency calls, ` +
        `suggesting the failure originates within the service itself rather than ` +
        `a downstream dependency.`,
      root_cause_service: serviceName,
      failing_dependencies: []
    };
  }

  // Check if any failing dependency is also anomalous
  const anomalousFailingDeps = failingDeps.filter(d => anomalousSet.has(d.destination));

  // Case B: Elevated errors to dependency X AND X is also anomalous → X is root cause
  if (anomalousFailingDeps.length > 0) {
    // Pick the dependency with the highest error rate as the likely root cause
    const primaryCause = anomalousFailingDeps
      .sort((a, b) => b.error_rate - a.error_rate)[0];

    return {
      is_root_cause: false,
      confidence: 'high',
      reasoning:
        `${serviceName} has elevated error rates calling ${primaryCause.destination} ` +
        `(${primaryCause.error_rate.toFixed(1)}% error rate, ${primaryCause.error_count} errors), ` +
        `and ${primaryCause.destination} is also showing anomalous behavior. ` +
        `${primaryCause.destination} is the likely root cause; ${serviceName} is a downstream victim.`,
      root_cause_service: primaryCause.destination,
      failing_dependencies: anomalousFailingDeps.map(d => ({
        destination: d.destination,
        error_rate: d.error_rate,
        error_count: d.error_count,
        call_count: d.call_count,
        is_anomalous: true
      }))
    };
  }

  // Case C: Elevated errors to X but X is NOT anomalous → service IS the root cause
  // with bad outbound call patterns
  return {
    is_root_cause: true,
    confidence: 'medium',
    reasoning:
      `${serviceName} has elevated error rates on outbound calls to ` +
      `${failingDeps.map(d => d.destination).join(', ')}, but those dependencies are not ` +
      `showing anomalous behavior themselves. The issue likely originates from ` +
      `${serviceName} sending malformed or excessive requests.`,
    root_cause_service: serviceName,
    failing_dependencies: failingDeps.map(d => ({
      destination: d.destination,
      error_rate: d.error_rate,
      error_count: d.error_count,
      call_count: d.call_count,
      is_anomalous: false
    }))
  };
}

// --- Public API ---

/**
 * Trace dependencies for an anomalous service and assess root cause.
 *
 * @param {string} serviceName - The anomalous service to trace
 * @param {string[]} otherAnomalousServices - Other services currently flagged as anomalous
 * @returns {Promise<{is_root_cause: boolean, confidence: string, reasoning: string,
 *   root_cause_service: string|null, failing_dependencies: Array, dependencies: Array}>}
 */
export async function traceDependencies(serviceName, otherAnomalousServices = []) {
  log.info(`Tracing dependencies for '${serviceName}' (${otherAnomalousServices.length} other anomalous services)`);

  try {
    const result = await executeEsqlTool('vigil-esql-dependency-tracer', {
      service_name: serviceName
    });

    const dependencies = extractDependencies(result);

    log.info(`Found ${dependencies.length} dependency link(s) for '${serviceName}'`);

    const assessment = assessRootCause(serviceName, dependencies, otherAnomalousServices);

    log.info(
      `Root cause assessment for '${serviceName}': ` +
      `is_root_cause=${assessment.is_root_cause}, confidence=${assessment.confidence}`
    );

    return {
      ...assessment,
      dependencies
    };
  } catch (err) {
    log.warn(`Dependency tracing failed for '${serviceName}': ${err.message}`);

    // Return a degraded assessment — assume root cause since we can't prove otherwise
    return {
      is_root_cause: true,
      confidence: 'low',
      reasoning:
        `Dependency tracing failed for ${serviceName}: ${err.message}. ` +
        `Assuming root cause by default.`,
      root_cause_service: serviceName,
      failing_dependencies: [],
      dependencies: []
    };
  }
}
