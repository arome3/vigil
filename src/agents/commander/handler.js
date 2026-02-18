// Commander Agent A2A request handler.
// Receives plan_remediation requests from vigil-coordinator, searches for
// matching runbooks, assesses service impact, and produces ordered
// remediation plans with approval tagging.

import { executeEsqlTool } from '../../tools/esql/executor.js';
import { validatePlanResponse } from '../../a2a/contracts.js';
import { searchRunbooks } from './runbook-matcher.js';
import { buildRemediationPlan, buildFallbackPlan } from './plan-builder.js';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('commander-handler');

// --- Configuration ---

const PLANNING_DEADLINE_MS =
  parseInt(process.env.VIGIL_PLANNING_DEADLINE_MS, 10) || 40000;

/** Max concurrent ES|QL impact queries to avoid overwhelming Elasticsearch. */
const MAX_CONCURRENT_IMPACT_QUERIES = 10;

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
 * Parse ES|QL columnar impact assessment result into a Map of service metrics.
 *
 * @param {{ columns: Array, values: Array }} result
 * @returns {Map<string, {active_requests: number, avg_latency: number, error_rate: number}>}
 */
function extractImpactMetrics(result) {
  const metrics = new Map();
  if (!result?.values?.length || !result?.columns?.length) return metrics;

  const col = buildColIndex(
    result.columns,
    ['service.name', 'active_requests', 'avg_latency', 'error_rate'],
    'impact-assessment'
  );

  for (const row of result.values) {
    const serviceName = row[col['service.name']];
    if (!serviceName) continue;

    metrics.set(serviceName, {
      active_requests: row[col['active_requests']] ?? 0,
      avg_latency: row[col['avg_latency']] ?? 0,
      error_rate: row[col['error_rate']] ?? 0
    });
  }

  return metrics;
}

// --- Tier-1 Asset Loading ---

/**
 * Load tier-1 critical asset IDs from the vigil-assets index.
 * Falls back to a conservative static set if the query fails.
 *
 * @returns {Promise<Set<string>>}
 */
async function loadTier1Assets() {
  const FALLBACK_TIER_1 = new Set([
    'api-gateway', 'auth-service', 'payment-service',
    'database-primary', 'load-balancer', 'dns-primary'
  ]);

  try {
    const resp = await client.search({
      index: 'vigil-assets',
      size: 200,
      _source: { includes: ['asset_id'] },
      query: { term: { criticality: 'tier-1' } }
    });

    const assets = new Set();
    for (const hit of resp.hits?.hits || []) {
      const id = hit._source?.asset_id;
      if (id) assets.add(id.toLowerCase());
    }

    if (assets.size === 0) {
      log.warn('No tier-1 assets found in vigil-assets index, using fallback set');
      return FALLBACK_TIER_1;
    }

    log.info(`Loaded ${assets.size} tier-1 assets from vigil-assets`);
    return assets;
  } catch (err) {
    log.warn(`Failed to load tier-1 assets: ${err.message} — using fallback set`);
    return FALLBACK_TIER_1;
  }
}

// --- Impact Assessment ---

/**
 * Run a batch of promises with a concurrency limit.
 *
 * @param {Array<() => Promise>} tasks - Factory functions that return promises
 * @param {number} limit - Maximum concurrent tasks
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function allSettledWithLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Run impact assessment ES|QL queries for all affected services in parallel,
 * capped at MAX_CONCURRENT_IMPACT_QUERIES to avoid overwhelming Elasticsearch.
 * Returns a merged Map of service → metrics.
 *
 * @param {string[]} affectedServices
 * @returns {Promise<Map<string, object>|null>}
 */
async function assessImpact(affectedServices) {
  if (!affectedServices?.length) return null;

  log.info(`Assessing impact for ${affectedServices.length} service(s)`, {
    services: affectedServices
  });

  const tasks = affectedServices.map(service =>
    () => executeEsqlTool('vigil-esql-impact-assessment', { target_service: service })
  );

  const results = await allSettledWithLimit(tasks, MAX_CONCURRENT_IMPACT_QUERIES);

  const mergedMetrics = new Map();

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const serviceMetrics = extractImpactMetrics(result.value);
      for (const [name, metrics] of serviceMetrics) {
        mergedMetrics.set(name, metrics);
      }
    } else {
      log.warn(`Impact assessment failed for ${affectedServices[i]}: ${result.reason?.message}`);
    }
  }

  return mergedMetrics.size > 0 ? mergedMetrics : null;
}

// --- Core Orchestration ---

/**
 * Main planning pipeline. Runs runbook search, impact assessment, and tier-1
 * asset loading in parallel, then builds the remediation plan from combined results.
 *
 * @param {object} envelope - Validated request envelope
 * @returns {Promise<object>} Plan response matching §8.4
 */
async function planRemediation(envelope) {
  const report = envelope.investigation_report || {};
  const affectedServices = envelope.affected_services || [];

  // Run all three data-gathering operations in parallel
  const [runbookResult, impactResult, tier1Result] = await Promise.allSettled([
    searchRunbooks(report, affectedServices),
    assessImpact(affectedServices),
    loadTier1Assets()
  ]);

  // Graceful degradation: use result if fulfilled, null/default if rejected
  const matchedRunbooks = runbookResult.status === 'fulfilled'
    ? runbookResult.value
    : null;

  if (runbookResult.status === 'rejected') {
    log.warn(`Runbook search failed (proceeding without): ${runbookResult.reason?.message}`);
  }

  const impactAssessments = impactResult.status === 'fulfilled'
    ? impactResult.value
    : null;

  if (impactResult.status === 'rejected') {
    log.warn(`Impact assessment failed (using defaults): ${impactResult.reason?.message}`);
  }

  // tier-1 loading never rejects (internal try/catch), but handle it defensively
  const tier1Assets = tier1Result.status === 'fulfilled'
    ? tier1Result.value
    : new Set();

  // Build the plan from all available context
  return buildRemediationPlan(envelope, matchedRunbooks, impactAssessments, tier1Assets);
}

// --- Request Handler ---

/**
 * A2A request handler for the Commander agent.
 * Validates the incoming request, races the planning pipeline against a deadline,
 * and returns a validated remediation plan.
 *
 * @param {object} envelope - Request from vigil-coordinator via buildPlanRequest()
 * @returns {Promise<object>} Validated plan response
 */
export async function handlePlanRequest(envelope) {
  // --- Validate request ---
  if (envelope.task !== 'plan_remediation') {
    throw new Error(`Commander received unknown task: '${envelope.task}' (expected 'plan_remediation')`);
  }

  if (!envelope.incident_id) {
    throw new Error('Commander request missing required field: incident_id');
  }

  if (!envelope.severity) {
    throw new Error('Commander request missing required field: severity');
  }

  if (!envelope.investigation_report) {
    throw new Error('Commander request missing required field: investigation_report');
  }

  const startTime = Date.now();
  log.info(`Planning remediation for incident ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    severity: envelope.severity,
    affected_services: envelope.affected_services?.length || 0,
    has_threat_scope: envelope.threat_scope != null
  });

  let response;
  let deadlineHandle;

  try {
    // Race planning against deadline to stay within A2A timeout
    const deadline = new Promise((_, reject) => {
      deadlineHandle = setTimeout(
        () => reject(new Error('Planning deadline exceeded')),
        PLANNING_DEADLINE_MS
      );
    });

    response = await Promise.race([
      planRemediation(envelope),
      deadline
    ]);
  } catch (err) {
    log.error(`Planning failed for ${envelope.incident_id}: ${err.message}`, {
      incident_id: envelope.incident_id,
      error: err.message
    });
    response = buildFallbackPlan(envelope.incident_id, envelope.severity, err.message);
  } finally {
    clearTimeout(deadlineHandle);
  }

  // Self-validate before returning
  validatePlanResponse(response);

  const elapsed = Date.now() - startTime;
  log.info(`Commander completed plan for ${envelope.incident_id}`, {
    incident_id: envelope.incident_id,
    action_count: response.remediation_plan.actions.length,
    requires_approval: response.remediation_plan.requires_approval,
    runbook_used: response.remediation_plan.runbook_used,
    elapsed_ms: elapsed
  });

  return response;
}
