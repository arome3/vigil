import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('esql-change-correlation-fallback');

const DEFAULT_TIMEOUT = 30_000;

// Query 1: Aggregate errors by service in the last hour
const ERROR_AGGREGATION_QUERY =
  'FROM logs-service-* ' +
  '| WHERE @timestamp > NOW() - 1h AND log.level == "ERROR" ' +
  '| STATS error_count = COUNT(), first_error = MIN(@timestamp) BY service.name';

// Query 2: Recent deployments in the last hour
const DEPLOYMENT_QUERY =
  'FROM github-events-* ' +
  '| WHERE @timestamp > NOW() - 1h AND event_type == "deployment" ' +
  '| KEEP @timestamp, service_name, event_type, commit.sha, commit.message, ' +
  'commit.author, pr.number, deployment.previous_sha';

/**
 * Column schema matching the native LOOKUP JOIN query output.
 * This ensures callers get the same structure regardless of which path executes.
 */
const OUTPUT_COLUMNS = [
  { name: 'service.name', type: 'keyword' },
  { name: 'error_count', type: 'long' },
  { name: 'commit.sha', type: 'keyword' },
  { name: 'commit.message', type: 'keyword' },
  { name: 'commit.author', type: 'keyword' },
  { name: 'pr.number', type: 'integer' },
  { name: 'time_gap_seconds', type: 'long' },
  { name: 'deployment.previous_sha', type: 'keyword' }
];

/**
 * Execute an ES|QL query and return the structured result.
 *
 * @param {string} query - ES|QL query string
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<{ columns: Array, values: Array }>}
 */
async function runQuery(query, timeout) {
  const response = await client.transport.request(
    {
      method: 'POST',
      path: '/_query',
      body: { query }
    },
    {
      requestTimeout: timeout,
      meta: true
    }
  );

  return {
    columns: response.body.columns || [],
    values: response.body.values || []
  };
}

/**
 * Convert an ES|QL result into an array of row objects keyed by column name.
 *
 * @param {{ columns: Array<{name: string}>, values: Array<Array> }} result
 * @returns {Array<object>}
 */
function resultToRows(result) {
  return result.values.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj;
  });
}

/**
 * Parse a timestamp value to a Date object.
 * Handles ISO strings and epoch millisecond numbers.
 *
 * @param {string|number} ts
 * @returns {Date}
 */
function parseTimestamp(ts) {
  if (typeof ts === 'number') return new Date(ts);
  return new Date(ts);
}

/**
 * Two-query fallback for vigil-esql-change-correlation.
 * Replicates the LOOKUP JOIN behavior by:
 *   1. Querying error aggregations from logs-service-*
 *   2. Querying recent deployments from github-events-*
 *   3. Joining client-side on service name + time window
 *
 * @param {object} params - Validated parameters
 * @param {number} [params.max_gap_seconds=600] - Maximum time gap between deployment and first error
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=30000] - Query timeout in milliseconds
 * @returns {Promise<{ columns: Array, values: Array, took: number }>}
 */
export async function executeChangeCorrelationFallback(params = {}, options = {}) {
  const maxGapSeconds = params.max_gap_seconds ?? 600;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const startTime = Date.now();

  log.info('Executing change correlation fallback (two-query approach)');

  // Execute both queries in parallel
  const [errorResult, deploymentResult] = await Promise.all([
    runQuery(ERROR_AGGREGATION_QUERY, timeout),
    runQuery(DEPLOYMENT_QUERY, timeout)
  ]);

  const errorRows = resultToRows(errorResult);
  const deploymentRows = resultToRows(deploymentResult);

  log.info(
    `Fallback: ${errorRows.length} error aggregations, ${deploymentRows.length} deployment events`
  );

  // Client-side join:
  // For each error row, find deployments where:
  //   - deployment.service_name matches error.service.name
  //   - deployment happened BEFORE the first error
  //   - time gap is within max_gap_seconds
  const joined = [];

  for (const error of errorRows) {
    const serviceName = error['service.name'];
    const firstError = parseTimestamp(error.first_error);

    for (const deployment of deploymentRows) {
      // Match on service name
      if (deployment.service_name !== serviceName) continue;

      const deployTime = parseTimestamp(deployment['@timestamp']);
      const timeGapSeconds = (firstError.getTime() - deployTime.getTime()) / 1000;

      // Deployment must be before the error and within the max gap
      if (timeGapSeconds <= 0 || timeGapSeconds >= maxGapSeconds) continue;

      joined.push({
        'service.name': serviceName,
        error_count: error.error_count,
        'commit.sha': deployment['commit.sha'] ?? null,
        'commit.message': deployment['commit.message'] ?? null,
        'commit.author': deployment['commit.author'] ?? null,
        'pr.number': deployment['pr.number'] ?? null,
        time_gap_seconds: Math.round(timeGapSeconds),
        'deployment.previous_sha': deployment['deployment.previous_sha'] ?? null
      });
    }
  }

  // Sort by time_gap_seconds ascending (closest deployment first)
  joined.sort((a, b) => a.time_gap_seconds - b.time_gap_seconds);

  // Limit to top 5
  const topResults = joined.slice(0, 5);

  // Convert back to columnar format matching the native query output
  const values = topResults.map(row =>
    OUTPUT_COLUMNS.map(col => row[col.name] ?? null)
  );

  const took = Date.now() - startTime;

  log.info(`Fallback complete: ${topResults.length} correlated results, took ${took}ms`);

  return { columns: OUTPUT_COLUMNS, values, took };
}
