// Threat Hunter Agent A2A request handler.
// Receives sweep_environment requests from vigil-coordinator, performs
// environment-wide IoC sweeps and behavioral anomaly detection, and returns
// a structured threat scope report.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { validateSweepResponse } from '../../a2a/contracts.js';
import { buildScopeReport } from './scope-report.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('threat-hunter-handler');

// --- Configuration ---

const SWEEP_DEADLINE_MS =
  parseInt(process.env.VIGIL_SWEEP_DEADLINE_MS, 10) || 45000;

const _rawThreshold = parseFloat(process.env.VIGIL_ANOMALY_THRESHOLD ?? '');
const ANOMALY_THRESHOLD = Number.isNaN(_rawThreshold) ? 8.0 : _rawThreshold;

// --- ES|QL Result Helpers ---

/**
 * Build a column-name-to-index map from ES|QL columnar results.
 * Same pattern as investigator/handler.js:35-45.
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

// --- IoC Sweep (dynamic query) ---

/**
 * Run the IoC sweep with a dynamically-built query that only includes
 * WHERE clauses for populated indicator arrays. This avoids sentinel
 * values (like '__none__') that could produce false positives when the
 * static query's OR-joined IN clauses match unintended data.
 *
 * Values are passed via ES|QL's parameterized `params` array — never
 * concatenated into the query string — preserving injection prevention.
 *
 * @param {string[]} ips - Malicious IP addresses
 * @param {string[]} domains - Malicious domains (C2, phishing)
 * @param {string[]} hashes - Malicious file hashes (SHA-256)
 * @param {string[]} processes - Malicious process names
 * @returns {Promise<{columns: Array, values: Array, took: number}|null>}
 */
async function runIocSweep(ips, domains, hashes, processes) {
  const clauses = [];
  const params = [];

  if (ips.length > 0) {
    clauses.push('destination.ip IN (?malicious_ips)');
    params.push({ malicious_ips: ips });
  }
  if (domains.length > 0) {
    clauses.push('dns.question.name IN (?malicious_domains)');
    params.push({ malicious_domains: domains });
  }
  if (hashes.length > 0) {
    clauses.push('file.hash.sha256 IN (?malicious_hashes)');
    params.push({ malicious_hashes: hashes });
  }
  if (processes.length > 0) {
    clauses.push('process.name IN (?malicious_processes)');
    params.push({ malicious_processes: processes });
  }

  if (clauses.length === 0) return null;

  const whereClause = clauses.join(' OR ');
  const query =
    'FROM logs-endpoint-*, logs-network-*, logs-dns-* ' +
    '| WHERE @timestamp > NOW() - 7d AND (' + whereClause + ') ' +
    '| STATS hit_count = COUNT(*), ' +
    'unique_indicators = COUNT_DISTINCT(COALESCE(destination.ip, dns.question.name, file.hash.sha256, process.name)), ' +
    'first_contact = MIN(@timestamp), last_contact = MAX(@timestamp) ' +
    'BY host.name, source.ip ' +
    '| SORT hit_count DESC ' +
    '| LIMIT 50';

  log.info(`IoC sweep: ${clauses.length} indicator type(s) active`);

  const body = { query };
  if (params.length > 0) {
    body.params = params;
  }

  const response = await client.transport.request(
    { method: 'POST', path: '/_query', body },
    { requestTimeout: 30_000, meta: true }
  );

  const result = response.body;
  const took = result.took ?? 0;
  const columns = result.columns || [];
  const values = result.values || [];

  log.info(`IoC sweep: ${values.length} rows, took ${took}ms`);

  return { columns, values, took };
}

// --- IoC Sweep Extraction ---

/**
 * Extract IoC hit rows from the ioc-sweep result.
 * Columns: host.name, source.ip, hit_count, unique_indicators,
 *          first_contact, last_contact
 *
 * @param {{ columns: Array, values: Array }|null} result
 * @returns {Array<{host: string, sourceIp: string, hitCount: number,
 *   uniqueIndicators: number, firstContact: string|null, lastContact: string|null}>}
 */
function extractIocHits(result) {
  if (!result?.values?.length || !result?.columns?.length) return [];

  const col = buildColIndex(
    result.columns,
    ['host.name', 'source.ip', 'hit_count', 'unique_indicators', 'first_contact', 'last_contact'],
    'ioc-sweep'
  );

  return result.values.map(row => ({
    host: row[col['host.name']] ?? 'unknown',
    sourceIp: row[col['source.ip']] ?? null,
    hitCount: row[col['hit_count']] ?? 0,
    uniqueIndicators: row[col['unique_indicators']] ?? 0,
    firstContact: row[col['first_contact']] ?? null,
    lastContact: row[col['last_contact']] ?? null
  }));
}

// --- Behavioral Anomaly Extraction ---

/**
 * Extract anomaly rows from the vigil-esql-behavioral-anomaly result.
 * Columns: user.name, login_count, unique_ips, unique_geos,
 *          off_hours_logins, failed_ratio, anomaly_score
 *
 * @param {{ columns: Array, values: Array }|null} result
 * @returns {Array<{userName: string, loginCount: number, uniqueIps: number,
 *   uniqueGeos: number, offHoursLogins: number, failedRatio: number,
 *   anomalyScore: number}>}
 */
function extractAnomalies(result) {
  if (!result?.values?.length || !result?.columns?.length) return [];

  const col = buildColIndex(
    result.columns,
    ['user.name', 'login_count', 'unique_ips', 'unique_geos', 'off_hours_logins', 'failed_ratio', 'anomaly_score'],
    'behavioral-anomaly'
  );

  return result.values.map(row => ({
    userName: row[col['user.name']] ?? 'unknown',
    loginCount: row[col['login_count']] ?? 0,
    uniqueIps: row[col['unique_ips']] ?? 0,
    uniqueGeos: row[col['unique_geos']] ?? 0,
    offHoursLogins: row[col['off_hours_logins']] ?? 0,
    failedRatio: row[col['failed_ratio']] ?? 0,
    anomalyScore: row[col['anomaly_score']] ?? 0
  }));
}

// --- Total Assets Count ---

/**
 * Count distinct hosts across security log indices over the past 7 days.
 * Uses a raw ES|QL query via client.transport.request (read-only).
 *
 * @returns {Promise<number>} Total distinct host count
 */
async function countTotalAssets() {
  const query = 'FROM logs-endpoint-*, logs-network-*, logs-dns-* ' +
    '| WHERE @timestamp > NOW() - 7d ' +
    '| STATS total = COUNT_DISTINCT(host.name)';

  const response = await client.transport.request(
    {
      method: 'POST',
      path: '/_query',
      body: { query }
    },
    {
      requestTimeout: 15_000,
      meta: true
    }
  );

  const values = response.body?.values || [];
  return values[0]?.[0] ?? 0;
}

// --- Deduplication ---

/**
 * Deduplicate anomaly entries by user.name, keeping the highest anomalyScore
 * when multiple behavioral-anomaly queries produce overlapping results.
 *
 * @param {Array} anomalies - Combined anomaly results from all queries
 * @returns {Array} Deduplicated anomalies
 */
function deduplicateAnomalies(anomalies) {
  const byUser = new Map();

  for (const anomaly of anomalies) {
    const existing = byUser.get(anomaly.userName);
    if (!existing || anomaly.anomalyScore > existing.anomalyScore) {
      byUser.set(anomaly.userName, anomaly);
    }
  }

  return [...byUser.values()];
}

// --- Deadline-Aware Promise Runner ---

/**
 * Run promises in parallel with a deadline, preserving partial results.
 *
 * Each promise's result is captured into a mutable slot as it settles.
 * When the deadline fires, promises that already completed still have their
 * results available — only genuinely pending promises show as rejected.
 *
 * @param {Array<{label: string, promise: Promise}>} tasks - Labeled promises
 * @param {number} deadlineMs - Maximum wait time in milliseconds
 * @returns {Promise<Array<{status: string, value?: *, reason?: Error}>>}
 */
async function raceWithPartialResults(tasks, deadlineMs) {
  const results = tasks.map(() => ({
    status: 'pending',
    value: undefined,
    reason: undefined
  }));

  // Capture each result into its slot as it settles
  const trackedPromises = tasks.map((task, i) =>
    task.promise.then(
      value => { results[i] = { status: 'fulfilled', value }; },
      reason => { results[i] = { status: 'rejected', reason }; }
    )
  );

  let deadlineHandle;
  const deadline = new Promise((_, reject) => {
    deadlineHandle = setTimeout(
      () => reject(new Error('Sweep deadline exceeded')),
      deadlineMs
    );
  });

  try {
    await Promise.race([Promise.all(trackedPromises), deadline]);
  } catch {
    // Deadline fired — results[] already has whatever completed in time
    const pendingLabels = tasks
      .filter((_, i) => results[i].status === 'pending')
      .map(t => t.label);
    if (pendingLabels.length > 0) {
      log.warn(`Deadline exceeded; still pending: ${pendingLabels.join(', ')}`);
    }
  } finally {
    clearTimeout(deadlineHandle);
  }

  // Convert any still-pending slots to rejected
  const deadlineError = new Error('Deadline exceeded before promise settled');
  return results.map((r, i) => {
    if (r.status === 'pending') {
      log.warn(`Promise '${tasks[i].label}' did not settle before deadline`);
      return { status: 'rejected', reason: deadlineError };
    }
    if (r.status === 'rejected') {
      log.warn(`Promise '${tasks[i].label}' rejected: ${r.reason?.message}`);
    }
    return r;
  });
}

// --- Main Handler ---

/**
 * Handle a sweep_environment A2A request.
 *
 * Orchestration flow:
 * 1. Validate request shape (task === 'sweep_environment', required fields)
 * 2. Extract indicator arrays and known compromised users
 * 3. Run IoC sweep, behavioral anomaly, and total assets count in parallel
 * 4. Race all promises against SWEEP_DEADLINE_MS (preserving partial results)
 * 5. Extract results with graceful degradation
 * 6. Deduplicate anomalies
 * 7. Build scope report
 * 8. Self-validate via validateSweepResponse()
 * 9. Return response (read-only — no writes to Elasticsearch)
 *
 * @param {object} envelope - A2A request envelope
 * @param {string} envelope.task - Must be 'sweep_environment'
 * @param {string} envelope.incident_id - Incident being swept
 * @param {object} [envelope.indicators] - IoC arrays: { ips, domains, hashes, processes }
 * @param {string[]} [envelope.known_compromised_users] - Users already confirmed compromised
 * @returns {Promise<object>} Validated sweep response matching §8.3 contract
 */
export async function handleSweepRequest(envelope) {
  // 1. Validate request
  if (envelope?.task !== 'sweep_environment') {
    throw new Error(`Invalid task: expected 'sweep_environment', got '${envelope?.task}'`);
  }
  if (!envelope.incident_id) {
    throw new Error('Missing required field: incident_id');
  }

  const startTime = Date.now();
  const incidentId = envelope.incident_id;

  log.info(`Starting environment sweep for incident ${incidentId}`);

  // 2. Extract indicators and compromised users
  const indicators = envelope.indicators || {};
  const ips = indicators.ips || [];
  const domains = indicators.domains || [];
  const hashes = indicators.hashes || [];
  const processes = indicators.processes || [];
  const knownCompromisedUsers = envelope.known_compromised_users || [];

  const hasAnyIndicators = ips.length > 0 || domains.length > 0 ||
    hashes.length > 0 || processes.length > 0;

  log.info(
    `Sweep indicators: ${ips.length} IPs, ${domains.length} domains, ` +
    `${hashes.length} hashes, ${processes.length} processes, ` +
    `${knownCompromisedUsers.length} known compromised user(s)`
  );

  // 3. Build labeled parallel tasks
  const tasks = [];

  // IoC sweep — dynamic query with only populated indicator types
  if (hasAnyIndicators) {
    tasks.push({
      label: 'ioc-sweep',
      promise: runIocSweep(ips, domains, hashes, processes)
    });
  } else {
    tasks.push({
      label: 'ioc-sweep-skipped',
      promise: Promise.resolve(null)
    });
  }

  // Track where behavioral anomaly results start/end in the tasks array
  const anomalyStartIdx = tasks.length;

  // Behavioral anomaly — one query per known compromised user
  // The tool takes a single known_compromised_user string to exclude
  if (knownCompromisedUsers.length > 0) {
    for (const user of knownCompromisedUsers) {
      tasks.push({
        label: `behavioral-anomaly:${user}`,
        promise: executeEsqlTool('vigil-esql-behavioral-anomaly', {
          anomaly_threshold: ANOMALY_THRESHOLD,
          known_compromised_user: user
        })
      });
    }
  } else {
    tasks.push({
      label: 'behavioral-anomaly-skipped',
      promise: Promise.resolve(null)
    });
  }

  const anomalyEndIdx = tasks.length;

  // Total assets count query (lightweight, parallel)
  const countIdx = tasks.length;
  tasks.push({
    label: 'total-assets-count',
    promise: countTotalAssets()
  });

  // 4. Race all tasks against SWEEP_DEADLINE_MS, preserving partial results
  const settled = await raceWithPartialResults(tasks, SWEEP_DEADLINE_MS);

  // 5. Extract results with graceful degradation

  // IoC sweep is always index 0
  const iocHits = extractIocHits(
    settled[0].status === 'fulfilled' ? settled[0].value : null
  );

  // Behavioral anomaly results: from anomalyStartIdx to anomalyEndIdx
  const allAnomalies = [];
  for (let i = anomalyStartIdx; i < anomalyEndIdx; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled' && result.value) {
      allAnomalies.push(...extractAnomalies(result.value));
    }
  }

  // Total assets count at its tracked index
  let totalAssetsScanned = 0;
  if (settled[countIdx].status === 'fulfilled') {
    totalAssetsScanned = typeof settled[countIdx].value === 'number'
      ? settled[countIdx].value
      : 0;
  }

  // 6. Deduplicate anomalies by user.name
  const dedupedAnomalies = deduplicateAnomalies(allAnomalies);

  // 7. Build scope report
  const scopeReport = buildScopeReport(iocHits, dedupedAnomalies, totalAssetsScanned);

  const elapsed = Date.now() - startTime;
  log.info(
    `Sweep for ${incidentId}: ${scopeReport.confirmed_compromised.length} confirmed, ` +
    `${scopeReport.suspected_compromised.length} suspected, elapsed=${elapsed}ms`
  );

  // 8. Assemble A2A response
  const response = {
    incident_id: incidentId,
    confirmed_compromised: scopeReport.confirmed_compromised,
    suspected_compromised: scopeReport.suspected_compromised,
    total_assets_scanned: scopeReport.total_assets_scanned,
    clean_assets: scopeReport.clean_assets
  };

  // 9. Self-validate against the contract
  validateSweepResponse(response);

  // 10. Return response — Threat Hunter is read-only per spec, no fire-and-forget writes
  return response;
}
