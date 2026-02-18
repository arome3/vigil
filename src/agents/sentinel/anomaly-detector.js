// Sentinel anomaly detection module.
// Dual-mode: continuous monitoring (all services) and on-demand health checks (single service).
// Both modes share fetchBaselines() and queryHealthMetrics() — the only difference is
// whether threshold comparison is applied (continuous) or raw data is returned (on-demand).

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { executeSearchTool } from '../../tools/search/executor.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('sentinel-anomaly');

// --- Configuration ---

const ANOMALY_STDDEV_THRESHOLD =
  parseFloat(process.env.VIGIL_ANOMALY_STDDEV_THRESHOLD) || 2.0;

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

// --- Baseline Fetching ---

/**
 * Fetch 7-day rolling baselines for a service from vigil-baselines.
 * Returns a map of metric_name → { avg, stddev, p95, p99 }.
 *
 * @param {string} serviceName - Target service
 * @returns {Promise<Map<string, {avg: number, stddev: number, p95: number, p99: number}>>}
 */
export async function fetchBaselines(serviceName) {
  const baselines = new Map();

  try {
    const result = await executeSearchTool('vigil-search-baselines', serviceName);

    if (!result?.results?.length) {
      log.warn(`No baselines found for service '${serviceName}'`);
      return baselines;
    }

    for (const doc of result.results) {
      if (doc.service_name !== serviceName) continue;

      baselines.set(doc.metric_name, {
        avg: doc.avg_value ?? 0,
        stddev: doc.stddev_value ?? 0,
        p95: doc.p95_value ?? 0,
        p99: doc.p99_value ?? 0
      });
    }

    log.info(`Loaded ${baselines.size} baseline metrics for '${serviceName}'`);
  } catch (err) {
    log.warn(`Failed to fetch baselines for '${serviceName}': ${err.message}`);
  }

  return baselines;
}

// --- Health Metrics Query ---

/**
 * Query current health metrics for a service via the ES|QL health monitor tool.
 * Passes baseline params so the query can compute inline latency/error deviations.
 *
 * @param {string} serviceName - Target service
 * @param {Map} baselines - Baseline map from fetchBaselines()
 * @returns {Promise<object|null>} Extracted metrics object, or null on failure
 */
export async function queryHealthMetrics(serviceName, baselines) {
  const latencyBaseline = baselines.get('avg_latency') || { avg: 0, stddev: 1 };
  const errorBaseline = baselines.get('error_rate') || { avg: 0, stddev: 1 };

  try {
    const result = await executeEsqlTool('vigil-esql-health-monitor', {
      service_name: serviceName,
      baseline_avg: latencyBaseline.avg,
      baseline_stddev: latencyBaseline.stddev || 1, // guard div-by-zero in ES|QL
      baseline_error_rate: errorBaseline.avg,
      baseline_error_stddev: errorBaseline.stddev || 1
    });

    if (!result?.values?.length || !result?.columns?.length) {
      log.warn(`Health monitor returned no data for '${serviceName}'`);
      return null;
    }

    const col = buildColIndex(
      result.columns,
      ['avg_latency', 'p95_latency', 'p99_latency', 'error_rate', 'throughput',
       'avg_cpu', 'avg_memory', 'latency_deviation', 'error_deviation'],
      'health-monitor'
    );

    const row = result.values[0];

    return {
      avg_latency: row[col['avg_latency']] ?? 0,
      p95_latency: row[col['p95_latency']] ?? 0,
      p99_latency: row[col['p99_latency']] ?? 0,
      error_rate: row[col['error_rate']] ?? 0,
      throughput: row[col['throughput']] ?? 0,
      avg_cpu: row[col['avg_cpu']] ?? 0,
      avg_memory: row[col['avg_memory']] ?? 0,
      latency_deviation: row[col['latency_deviation']] ?? 0,
      error_deviation: row[col['error_deviation']] ?? 0
    };
  } catch (err) {
    log.warn(`Health monitor query failed for '${serviceName}': ${err.message}`);
    return null;
  }
}

// --- Deviation Computation ---

/**
 * Compute sigma deviations for all 7 metrics.
 * The ES|QL query computes latency_deviation and error_deviation inline;
 * the remaining 5 (p95, p99, throughput, cpu, memory) are computed locally.
 *
 * @param {object} metrics - Current metrics from queryHealthMetrics()
 * @param {Map} baselines - Baseline map from fetchBaselines()
 * @returns {object} Map of metric_name → { current_value, baseline_avg, baseline_stddev, deviation_sigma }
 */
export function computeDeviations(metrics, baselines) {
  const deviations = {};

  // Latency and error rate deviations come from ES|QL inline computation.
  // Store the guarded stddev consistently (|| 1) so downstream readers
  // never see baseline_stddev: 0 in the report.
  const latencyBl = baselines.get('avg_latency') || { avg: 0, stddev: 1 };
  deviations.avg_latency = {
    current_value: metrics.avg_latency,
    baseline_avg: latencyBl.avg,
    baseline_stddev: latencyBl.stddev || 1,
    deviation_sigma: metrics.latency_deviation
  };

  const errorBl = baselines.get('error_rate') || { avg: 0, stddev: 1 };
  deviations.error_rate = {
    current_value: metrics.error_rate,
    baseline_avg: errorBl.avg,
    baseline_stddev: errorBl.stddev || 1,
    deviation_sigma: metrics.error_deviation
  };

  // Remaining 5 metrics: compute locally as (current - avg) / stddev
  const localMetrics = [
    { name: 'p95_latency', value: metrics.p95_latency },
    { name: 'p99_latency', value: metrics.p99_latency },
    { name: 'throughput', value: metrics.throughput },
    { name: 'avg_cpu', value: metrics.avg_cpu },
    { name: 'avg_memory', value: metrics.avg_memory }
  ];

  for (const { name, value } of localMetrics) {
    const bl = baselines.get(name) || { avg: 0, stddev: 1 };
    const stddev = bl.stddev || 1; // guard against division-by-zero
    const sigma = (value - bl.avg) / stddev;

    deviations[name] = {
      current_value: value,
      baseline_avg: bl.avg,
      baseline_stddev: stddev,
      deviation_sigma: sigma
    };
  }

  return deviations;
}

// --- Service Discovery ---

/**
 * Discover all services that have baseline data in vigil-baselines.
 * Uses a direct ES aggregation (terms agg on service_name) instead of
 * multi_match with '*', which does NOT function as a match-all.
 *
 * @returns {Promise<string[]>} Unique service names
 */
export async function discoverMonitoredServices() {
  try {
    const result = await client.search({
      index: 'vigil-baselines',
      size: 0,
      query: {
        range: { computed_at: { gte: 'now-24h' } }
      },
      aggs: {
        services: {
          terms: { field: 'service_name', size: 100 }
        }
      }
    });

    const buckets = result.aggregations?.services?.buckets || [];
    if (buckets.length === 0) {
      log.warn('No baseline data found — no services to monitor');
      return [];
    }

    const serviceList = buckets.map(b => b.key);
    log.info(`Discovered ${serviceList.length} monitored service(s): ${serviceList.join(', ')}`);
    return serviceList;
  } catch (err) {
    log.warn(`Service discovery failed: ${err.message}`);
    return [];
  }
}

// --- On-Demand Mode (for Verifier) ---

/**
 * Check health for a single service. Returns raw metrics WITHOUT anomaly
 * interpretation. Used by the Verifier agent for post-remediation checks.
 *
 * @param {string} serviceName - Service to check
 * @returns {Promise<object>} Raw health data with data quality indicator
 */
export async function checkServiceHealth(serviceName) {
  log.info(`On-demand health check for '${serviceName}'`);

  const baselines = await fetchBaselines(serviceName);
  const metrics = await queryHealthMetrics(serviceName, baselines);

  const expectedMetrics = 7;
  const baselineCoverage = baselines.size;

  if (!metrics) {
    return {
      service_name: serviceName,
      status: 'no_data',
      metrics: null,
      baselines: Object.fromEntries(baselines),
      baseline_coverage: baselineCoverage,
      expected_metrics: expectedMetrics,
      checked_at: new Date().toISOString()
    };
  }

  return {
    service_name: serviceName,
    status: baselineCoverage === 0 ? 'degraded' : 'ok',
    metrics,
    baselines: Object.fromEntries(baselines),
    baseline_coverage: baselineCoverage,
    expected_metrics: expectedMetrics,
    checked_at: new Date().toISOString()
  };
}

// --- Continuous Mode (proactive monitoring) ---

/**
 * Monitor all discovered services. Runs baselines + health query + deviation
 * computation for each service in parallel, flags anomalies where any metric
 * exceeds the configured sigma threshold.
 *
 * @returns {Promise<object>} { anomalies[], healthy_services[], monitored_services, checked_at }
 */
export async function monitorAllServices() {
  const services = await discoverMonitoredServices();
  if (services.length === 0) {
    return {
      anomalies: [],
      healthy_services: [],
      monitored_services: 0,
      checked_at: new Date().toISOString()
    };
  }

  // Check all services in parallel
  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      const baselines = await fetchBaselines(serviceName);
      const metrics = await queryHealthMetrics(serviceName, baselines);
      return { serviceName, baselines, metrics };
    })
  );

  const anomalies = [];
  const healthyServices = [];

  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn(`Service monitoring failed: ${result.reason?.message}`);
      continue;
    }

    const { serviceName, baselines, metrics } = result.value;

    if (!metrics) {
      log.warn(`Skipping '${serviceName}' — no health data`);
      continue;
    }

    const deviations = computeDeviations(metrics, baselines);

    // Check all metrics against threshold — use Math.abs() because
    // a throughput drop is anomalous too
    const anomalousMetrics = {};
    let isAnomalous = false;

    for (const [metricName, deviation] of Object.entries(deviations)) {
      if (Math.abs(deviation.deviation_sigma) > ANOMALY_STDDEV_THRESHOLD) {
        anomalousMetrics[metricName] = deviation;
        isAnomalous = true;
      }
    }

    if (isAnomalous) {
      // Determine the primary anomaly type from the highest deviation
      const [primaryMetric] = Object.entries(anomalousMetrics)
        .sort((a, b) => Math.abs(b[1].deviation_sigma) - Math.abs(a[1].deviation_sigma))[0];

      anomalies.push({
        service_name: serviceName,
        anomaly_type: `${primaryMetric}_spike`,
        metric_deviations: anomalousMetrics,
        all_metrics: metrics,
        detected_at: new Date().toISOString()
      });

      log.info(
        `ANOMALY detected: '${serviceName}' — ${Object.keys(anomalousMetrics).length} metric(s) ` +
        `beyond ${ANOMALY_STDDEV_THRESHOLD}σ threshold (primary: ${primaryMetric})`
      );
    } else {
      healthyServices.push(serviceName);
    }
  }

  log.info(
    `Monitoring complete: ${anomalies.length} anomalies, ` +
    `${healthyServices.length} healthy, ${services.length} total`
  );

  return {
    anomalies,
    healthy_services: healthyServices,
    monitored_services: services.length,
    checked_at: new Date().toISOString()
  };
}
