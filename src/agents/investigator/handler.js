// Investigator Agent A2A request handler.
// Receives investigation requests from vigil-coordinator, performs deep-dive
// analysis (security or operational), and returns structured findings.

import { v4 as uuidv4 } from 'uuid';
import { executeEsqlTool } from '../../tools/esql/executor.js';
import { executeSearchTool } from '../../tools/search/executor.js';
import { validateInvestigateResponse } from '../../a2a/contracts.js';
import { correlateChanges } from './change-correlator.js';
import { mapToMitre } from './mitre-mapper.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('investigator-handler');

// --- Configuration ---

const INVESTIGATION_DEADLINE_MS =
  parseInt(process.env.VIGIL_INVESTIGATION_DEADLINE_MS, 10) || 55000;

const SPARSE_RESULT_THRESHOLD =
  parseInt(process.env.VIGIL_SPARSE_RESULT_THRESHOLD, 10) || 3;

const CHANGE_GAP_MAX_SECONDS =
  parseInt(process.env.VIGIL_CHANGE_GAP_MAX_SECONDS, 10) || 3600;

// Progressive time windows for attack chain tracing (hours)
const TIME_WINDOWS = [1, 6, 24];

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

// --- Attack Chain Extraction ---

/**
 * Extract attack chain events and IoCs from the attack-chain-tracer result.
 * Note: the tracer query does not return IP columns — IPs come from the
 * initial alert context, not from chain tracing.
 *
 * @param {{ columns: Array, values: Array }} result
 * @returns {{ events: Array, hostnames: string[], processes: string[] }}
 */
function extractAttackChain(result) {
  const empty = { events: [], hostnames: [], processes: [] };
  if (!result?.values?.length || !result?.columns?.length) return empty;

  const col = buildColIndex(
    result.columns,
    ['host.name', 'process.name', 'event.action', 'event_count', 'unique_hosts', 'earliest', 'latest'],
    'attack-chain-tracer'
  );

  const hostnames = new Set();
  const processes = new Set();
  const events = [];

  for (const row of result.values) {
    // Use destination.ip as fallback host identifier for network-only queries
    const hostname = row[col['host.name']] ?? row[col['destination.ip']] ?? null;
    const processName = row[col['process.name']] ?? null;
    const action = row[col['event.action']] ?? null;

    if (hostname) hostnames.add(hostname);
    if (processName) processes.add(processName);

    events.push({
      host: hostname,
      process: processName,
      action,
      event_count: row[col['event_count']] ?? 0,
      earliest: row[col['earliest']] ?? null,
      latest: row[col['latest']] ?? null
    });
  }

  return {
    events,
    hostnames: [...hostnames],
    processes: [...processes]
  };
}

// --- Blast Radius Extraction ---

/**
 * Extract blast radius entries from the blast-radius ES|QL result.
 * Each entry has asset_id (destination.ip) to satisfy coordinator's
 * extractAffectedServices() at delegation.js:86.
 *
 * @param {{ columns: Array, values: Array }} result
 * @returns {Array<{asset_id: string, destination_port: number|null,
 *   connection_count: number, confidence: number, impact_type: string}>}
 */
function extractBlastRadius(result) {
  if (!result?.values?.length || !result?.columns?.length) return [];

  const col = buildColIndex(
    result.columns,
    ['destination.ip', 'destination.port', 'connection_count', 'confidence', 'data_volume'],
    'blast-radius'
  );

  return result.values.map(row => ({
    asset_id: row[col['destination.ip']] ?? 'unknown',
    destination_port: row[col['destination.port']] ?? null,
    connection_count: row[col['connection_count']] ?? 0,
    confidence: row[col['confidence']] ?? 0,
    data_volume: row[col['data_volume']] ?? 0,
    impact_type: 'lateral_movement'
  }));
}

// --- Threat Intel Extraction ---

/**
 * Extract threat intel matches from search results.
 * Each entry has ioc_value to satisfy coordinator's extractIndicators() at delegation.js:100.
 *
 * @param {{ results: Array, total: number }} searchResult
 * @returns {Array<{ioc_value: string, type: string, threat_actor: string|null,
 *   confidence: number|null, source: string|null}>}
 */
function extractThreatIntel(searchResult) {
  if (!searchResult?.results?.length) return [];

  return searchResult.results.map(hit => ({
    ioc_value: hit.value ?? hit.ioc_id ?? '',
    type: hit.type ?? 'unknown',
    threat_actor: hit.threat_actor ?? null,
    confidence: hit.confidence ?? null,
    source: hit.source ?? null,
    mitre_technique_id: hit.mitre_technique_id ?? null
  }));
}

// --- Index Investigation Report ---

/**
 * Index the investigation report to vigil-investigations (fire-and-forget).
 *
 * @param {object} report - The validated investigation response
 */
async function indexReport(report) {
  try {
    await client.index({
      index: 'vigil-investigations',
      id: report.investigation_id,
      document: {
        ...report,
        '@timestamp': new Date().toISOString()
      },
      refresh: false
    });
    log.info(`Indexed investigation report ${report.investigation_id}`);
  } catch (err) {
    log.warn(`Failed to index investigation report ${report.investigation_id}: ${err.message}`);
  }
}

// --- Security Investigation Flow ---

/**
 * Run the full security investigation pipeline:
 * 1. Progressive attack chain tracing
 * 2. Parallel blast radius, MITRE mapping, threat intel, similarity search
 * 3. Synthesize findings
 */
async function investigateSecurity(envelope) {
  const ctx = envelope.alert_context || {};
  const indicators = ctx.initial_indicators || {};
  const initialIndicator = (ctx.alert_ids?.[0]) || 'unknown';
  const indicatorIp = indicators.ips?.[0] || ctx.source_ip || '';
  const indicatorHash = indicators.hashes?.[0] || '';

  // --- Step 1: Progressive Attack Chain Tracing ---
  let chainResult = null;
  let chainData = { events: [], hostnames: [], processes: [] };
  let usedNetworkFallback = false;

  for (const hours of TIME_WINDOWS) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
    const windowEnd = now.toISOString();

    log.info(`Attack chain trace: ${hours}h window (${windowStart} → ${windowEnd})`);

    try {
      chainResult = await executeEsqlTool('vigil-esql-attack-chain-tracer', {
        window_start: windowStart,
        window_end: windowEnd,
        initial_indicator: initialIndicator,
        indicator_ip: indicatorIp,
        indicator_hash: indicatorHash
      });

      chainData = extractAttackChain(chainResult);

      if (chainData.events.length >= SPARSE_RESULT_THRESHOLD) {
        log.info(`Attack chain: found ${chainData.events.length} events in ${hours}h window`);
        break;
      }

      log.info(`Attack chain: only ${chainData.events.length} events in ${hours}h window, widening`);
    } catch (err) {
      // If the query fails due to missing columns (e.g. no endpoint data),
      // fall back to a network-only query using source.ip directly
      if (indicatorIp && /unknown column/i.test(err.message) && !usedNetworkFallback) {
        log.info(`Attack chain: endpoint fields unavailable, falling back to network-only query`);
        usedNetworkFallback = true;
        try {
          chainResult = await executeEsqlTool('vigil-esql-attack-chain-network', {
            window_start: windowStart,
            window_end: windowEnd,
            indicator_ip: indicatorIp
          });
          chainData = extractAttackChain(chainResult);
          if (chainData.events.length >= SPARSE_RESULT_THRESHOLD) {
            log.info(`Attack chain (network): found ${chainData.events.length} events in ${hours}h window`);
            break;
          }
        } catch (fallbackErr) {
          log.warn(`Network-only attack chain also failed: ${fallbackErr.message}`);
        }
      } else {
        log.warn(`Attack chain trace failed for ${hours}h window: ${err.message}`);
      }
    }
  }

  // --- Step 2: Parallel Tools ---
  // Build IPs list from initial indicators (tracer query has no IP column)
  const compromisedIps = [
    ...new Set([...(indicators.ips || []), indicatorIp].filter(Boolean))
  ];

  // Build behavior descriptions for MITRE mapping
  const behaviorDescriptions = chainData.events
    .map(e => [e.action, e.process, e.host].filter(Boolean).join(' on '))
    .filter(Boolean);

  // Build IoC query for threat intel
  const allIocs = [
    ...compromisedIps,
    ...(indicators.hashes || []),
    ...(indicators.domains || []),
    ...chainData.hostnames
  ].filter(Boolean);
  const iocQuery = allIocs.join(' ');

  // Build summary text for similarity search
  const summaryText = [
    `Security incident involving ${chainData.events.length} attack chain events`,
    compromisedIps.length ? `IPs: ${compromisedIps.join(', ')}` : null,
    chainData.processes.length ? `Processes: ${chainData.processes.join(', ')}` : null,
    behaviorDescriptions.length ? `Behaviors: ${behaviorDescriptions.slice(0, 3).join('; ')}` : null
  ].filter(Boolean).join('. ');

  const [blastResult, mitreResult, threatIntelResult, similarityResult] = await Promise.allSettled([
    compromisedIps.length
      ? executeEsqlTool('vigil-esql-blast-radius', { compromised_ips: compromisedIps })
      : Promise.resolve(null),
    behaviorDescriptions.length
      ? mapToMitre(behaviorDescriptions)
      : Promise.resolve([]),
    iocQuery
      ? executeSearchTool('vigil-search-threat-intel', iocQuery)
      : Promise.resolve({ results: [], total: 0 }),
    summaryText
      ? executeSearchTool('vigil-search-incident-similarity', summaryText)
      : Promise.resolve({ results: [], total: 0 })
  ]);

  // --- Step 3: Extract results with graceful degradation ---
  const blastRadius = extractBlastRadius(
    blastResult.status === 'fulfilled' ? blastResult.value : null
  );
  if (blastResult.status === 'rejected') {
    log.warn(`Blast radius failed: ${blastResult.reason?.message}`);
  }

  const mitreTechniques = mitreResult.status === 'fulfilled' ? mitreResult.value : [];
  if (mitreResult.status === 'rejected') {
    log.warn(`MITRE mapping failed: ${mitreResult.reason?.message}`);
  }

  const threatIntelMatches = extractThreatIntel(
    threatIntelResult.status === 'fulfilled' ? threatIntelResult.value : null
  );
  if (threatIntelResult.status === 'rejected') {
    log.warn(`Threat intel search failed: ${threatIntelResult.reason?.message}`);
  }

  const similarIncidents = similarityResult.status === 'fulfilled'
    ? (similarityResult.value?.results || [])
    : [];
  if (similarityResult.status === 'rejected') {
    log.warn(`Similarity search failed: ${similarityResult.reason?.message}`);
  }

  // --- Step 4: Synthesize root cause ---
  const rootCauseParts = [];
  if (chainData.events.length > 0) {
    rootCauseParts.push(
      `Attack chain traced ${chainData.events.length} events across ` +
      `${chainData.hostnames.length} host(s) involving ${chainData.processes.length} process(es).`
    );
  }
  if (mitreTechniques.length > 0) {
    rootCauseParts.push(
      `Mapped to MITRE ATT&CK: ${mitreTechniques.slice(0, 3).map(t => `${t.technique_id} (${t.technique_name})`).join(', ')}.`
    );
  }
  if (threatIntelMatches.length > 0) {
    rootCauseParts.push(
      `Threat intel matched ${threatIntelMatches.length} IoC(s): ${threatIntelMatches.slice(0, 3).map(t => t.ioc_value).join(', ')}.`
    );
  }
  if (blastRadius.length > 0) {
    rootCauseParts.push(
      `Blast radius includes ${blastRadius.length} potentially compromised asset(s).`
    );
  }
  if (envelope.previous_failure_analysis) {
    rootCauseParts.push(`Prior analysis: ${envelope.previous_failure_analysis}`);
  }

  const rootCause = rootCauseParts.length > 0
    ? rootCauseParts.join(' ')
    : 'Insufficient data to determine root cause from available telemetry.';

  // --- Step 5: Determine recommended next step ---
  // Coordinator checks recommended_next === 'threat_hunt' at delegation.js:228
  const recommendedNext = threatIntelMatches.length > 0 ? 'threat_hunt' : 'plan_remediation';

  return {
    root_cause: rootCause,
    attack_chain: chainData.events,
    blast_radius: blastRadius,
    mitre_techniques: mitreTechniques,
    threat_intel_matches: threatIntelMatches,
    similar_incidents: similarIncidents,
    recommended_next: recommendedNext
  };
}

// --- Operational Investigation Flow ---

/**
 * Run the operational investigation pipeline:
 * 1. Correlate deployment changes with error spikes
 * 2. Build root cause from correlation result
 */
async function investigateOperational(envelope) {
  const correlation = await correlateChanges(CHANGE_GAP_MAX_SECONDS);

  let rootCause;
  if (correlation.matched) {
    rootCause =
      `Operational incident correlated with deployment: commit ${correlation.commit_sha} ` +
      `by ${correlation.commit_author}` +
      (correlation.pr_number ? ` (PR #${correlation.pr_number})` : '') +
      ` on service ${correlation.service_name}. ` +
      `Time gap: ${correlation.time_gap_seconds}s (confidence: ${correlation.confidence}).`;
  } else {
    rootCause = 'No recent deployment correlated with the error spike. Manual investigation recommended.';
  }

  if (envelope.previous_failure_analysis) {
    rootCause += ` Prior analysis: ${envelope.previous_failure_analysis}`;
  }

  // Coordinator checks recommended_next at delegation.js:228
  const recommendedNext = correlation.matched ? 'plan_remediation' : 'escalate';

  return {
    root_cause: rootCause,
    attack_chain: [],
    blast_radius: [],
    change_correlation: correlation,
    threat_intel_matches: [],
    recommended_next: recommendedNext
  };
}

// --- Main Handler ---

/**
 * Handle an investigation A2A request.
 *
 * Orchestration flow:
 * 1. Validate request shape (task === 'investigate', required fields)
 * 2. Branch on incident_type: security vs operational
 * 3. Build and self-validate response against §8.2 contract
 * 4. Index report to vigil-investigations (fire-and-forget)
 * 5. Return validated response
 *
 * @param {object} envelope - A2A request envelope
 * @param {string} envelope.task - Must be 'investigate'
 * @param {string} envelope.incident_id - Incident being investigated
 * @param {string} envelope.incident_type - 'security' or 'operational'
 * @param {object} envelope.alert_context - Alert context from coordinator
 * @param {string} [envelope.previous_failure_analysis] - Reflection loop context
 * @returns {Promise<object>} Validated investigation response matching §8.2 contract
 */
export async function handleInvestigateRequest(envelope) {
  // 1. Validate request
  if (envelope?.task !== 'investigate') {
    throw new Error(`Invalid task: expected 'investigate', got '${envelope?.task}'`);
  }
  if (!envelope.incident_id) {
    throw new Error('Missing required field: incident_id');
  }
  if (!envelope.incident_type) {
    throw new Error('Missing required field: incident_type');
  }
  if (!envelope.alert_context) {
    throw new Error('Missing required field: alert_context');
  }

  const startTime = Date.now();
  const investigationId = `INV-${new Date().getFullYear()}-${uuidv4().slice(0, 5).toUpperCase()}-01`;

  log.info(
    `Starting ${envelope.incident_type} investigation ${investigationId} ` +
    `for incident ${envelope.incident_id}`
  );

  // 2. Race investigation against deadline
  let deadlineHandle;
  const deadline = new Promise((_, reject) => {
    deadlineHandle = setTimeout(
      () => reject(new Error('Investigation deadline exceeded')),
      INVESTIGATION_DEADLINE_MS
    );
  });

  let findings;
  try {
    findings = await Promise.race([
      envelope.incident_type === 'security'
        ? investigateSecurity(envelope)
        : investigateOperational(envelope),
      deadline
    ]);
  } catch (err) {
    log.error(`Investigation ${investigationId} failed: ${err.message}`);

    // Return a minimal valid response on failure
    findings = {
      root_cause: `Investigation failed: ${err.message}`,
      attack_chain: [],
      blast_radius: [],
      threat_intel_matches: [],
      recommended_next: 'escalate'
    };
  } finally {
    clearTimeout(deadlineHandle);
  }

  // 3. Assemble response
  const response = {
    investigation_id: investigationId,
    incident_id: envelope.incident_id,
    root_cause: findings.root_cause,
    attack_chain: findings.attack_chain,
    blast_radius: findings.blast_radius,
    recommended_next: findings.recommended_next,
    // Optional fields
    ...(findings.mitre_techniques?.length && { mitre_techniques: findings.mitre_techniques }),
    ...(findings.threat_intel_matches?.length && { threat_intel_matches: findings.threat_intel_matches }),
    ...(findings.similar_incidents?.length && { similar_incidents: findings.similar_incidents }),
    ...(findings.change_correlation && { change_correlation: findings.change_correlation })
  };

  // 4. Self-validate against the contract
  validateInvestigateResponse(response);

  const elapsed = Date.now() - startTime;
  log.info(
    `Investigation ${investigationId}: type=${envelope.incident_type}, ` +
    `recommended_next=${response.recommended_next}, elapsed=${elapsed}ms`
  );

  // 5. Index report — fire-and-forget
  indexReport(response).catch(err => {
    log.warn(`Background index failed for ${investigationId}: ${err.message}`);
  });

  return response;
}
