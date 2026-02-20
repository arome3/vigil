// Agent discovery service — bulk resolution, health checks, cache refresh.
// Wraps agent-cards.js with fleet-wide operations using Promise.allSettled
// for resilience (one unavailable agent never blocks discovery of the rest).

import { getAgentCard, clearCache, AgentUnavailableError } from './agent-cards.js';
import { createLogger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';

const log = createLogger('a2a-discovery');

const KIBANA_URL = process.env.KIBANA_URL;

const VIGIL_AGENTS = Object.freeze([
  'vigil-coordinator', 'vigil-triage', 'vigil-investigator',
  'vigil-threat-hunter', 'vigil-sentinel', 'vigil-commander',
  'vigil-executor', 'vigil-verifier'
]);

// ── Retry helper (mirrors src/agents/executor/audit-logger.js) ──

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

function isRetryable(err) {
  const status = err.statusCode ?? err.response?.status ?? err.meta?.statusCode;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
      log.warn(`${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── Staleness tracking ──────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches agent-cards.js

let lastDiscovery = { results: null, timestamp: 0 };
let refreshLock = false;

// ── Status-change event emitter ─────────────────────────────

export const discoveryEvents = new EventEmitter();
discoveryEvents.setMaxListeners(50);

// ── Internal helpers ────────────────────────────────────────

function detectStatusChanges(previous, current) {
  if (!previous) return; // first discovery — nothing to compare

  const prevAvailableIds = new Set(previous.available.map((c) => c.agent_id));
  const currAvailableIds = new Set(current.available.map((c) => c.agent_id));

  // Agents that went down
  for (const id of prevAvailableIds) {
    if (!currAvailableIds.has(id)) {
      const reason = current.unavailable.find((u) => u.agentId === id)?.reason || 'unknown';
      discoveryEvents.emit('agent:down', id, reason);
    }
  }

  // Agents that came up
  for (const id of currAvailableIds) {
    if (!prevAvailableIds.has(id)) {
      const card = current.available.find((c) => c.agent_id === id);
      discoveryEvents.emit('agent:up', id, card);
    }
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Discover all registered Vigil agents in parallel.
 * @param {string[]} [agents] - Optional list of agent IDs (defaults to VIGIL_AGENTS)
 * @returns {{ available: object[], unavailable: { agentId: string, reason: string }[] }}
 */
export async function discoverAllAgents(agents) {
  const agentList = agents || VIGIL_AGENTS;

  const results = await Promise.allSettled(
    agentList.map(async (agentId) => {
      const start = Date.now();
      const card = await withRetry(
        () => getAgentCard(agentId),
        `discover(${agentId})`
      );
      const latencyMs = Date.now() - start;
      return { agentId, card, latencyMs };
    })
  );

  const available = [];
  const unavailable = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      available.push(result.value.card);
    } else {
      const err = result.reason;
      const agentId = err.agentId || 'unknown';
      unavailable.push({ agentId, reason: err.message });
      log.warn(`Agent unavailable during discovery: ${agentId} — ${err.message}`);
    }
  }

  log.info(`Discovery complete: ${available.length} available, ${unavailable.length} unavailable`);

  const current = { available, unavailable };
  detectStatusChanges(lastDiscovery.results, current);
  lastDiscovery = { results: current, timestamp: Date.now() };

  return current;
}

/**
 * Resolve the full endpoint URL for a single agent.
 * @param {string} agentId
 * @returns {string} The agent's full endpoint URL
 * @throws {AgentUnavailableError} if the agent cannot be reached or has no endpoint
 */
export async function resolveAgentEndpoint(agentId) {
  if (!KIBANA_URL) {
    throw new Error('KIBANA_URL environment variable is not set');
  }
  const card = await getAgentCard(agentId);
  if (!card.endpoint) {
    throw new AgentUnavailableError(agentId, 'agent card missing endpoint field');
  }
  return `${KIBANA_URL}${card.endpoint}`;
}

/**
 * Check health of a single agent with latency measurement — never throws.
 * @param {string} agentId
 * @returns {{ agentId: string, healthy: boolean, lastChecked: string, latencyMs?: number, version?: string, capabilities?: string[], error?: string }}
 */
export async function checkAgentHealth(agentId) {
  const start = Date.now();
  try {
    const card = await getAgentCard(agentId);
    const latencyMs = Date.now() - start;
    return {
      agentId,
      healthy: true,
      lastChecked: new Date().toISOString(),
      latencyMs,
      ...(card.version && { version: card.version }),
      ...(card.capabilities && { capabilities: card.capabilities })
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      agentId,
      healthy: false,
      lastChecked: new Date().toISOString(),
      latencyMs,
      error: err.message
    };
  }
}

/**
 * Clear the agent card cache and re-discover all agents.
 * Guards against concurrent refreshes — if already refreshing, returns stale results.
 * @returns {{ available: number, unavailable: number }}
 */
export async function refreshAgentCache() {
  if (refreshLock) {
    log.warn('Refresh already in progress, returning stale results');
    const stale = lastDiscovery.results;
    return {
      available: stale?.available?.length ?? 0,
      unavailable: stale?.unavailable?.length ?? 0
    };
  }

  refreshLock = true;
  try {
    clearCache();
    log.info('Agent card cache cleared, re-discovering agents');
    const { available, unavailable } = await discoverAllAgents();
    return { available: available.length, unavailable: unavailable.length };
  } finally {
    refreshLock = false;
  }
}

/**
 * Resolve agent capabilities, optionally filtering by task name.
 * @param {string} agentId
 * @param {string} [taskName] - Optional task name to match
 * @returns {string[]|object} Full capabilities array or matching capability
 * @throws {AgentUnavailableError} if agent unavailable or doesn't support requested task
 */
export async function resolveAgentCapabilities(agentId, taskName) {
  const card = await getAgentCard(agentId);
  const capabilities = card.capabilities || [];

  if (!taskName) return capabilities;

  const match = capabilities.find(
    (cap) => (typeof cap === 'string' ? cap === taskName : cap.task === taskName)
  );

  if (!match) {
    throw new AgentUnavailableError(agentId, `does not support task '${taskName}'`);
  }
  return match;
}

/**
 * Get the last discovery results with staleness indicator.
 * @returns {{ results: object|null, timestamp: number, stale: boolean }|null}
 */
export function getLastDiscovery() {
  if (!lastDiscovery.results) return null;
  const stale = Date.now() - lastDiscovery.timestamp > CACHE_TTL_MS;
  return {
    results: structuredClone(lastDiscovery.results),
    timestamp: lastDiscovery.timestamp,
    stale
  };
}

// ── Exported for testing ────────────────────────────────────

export function _resetState() {
  lastDiscovery = { results: null, timestamp: 0 };
  refreshLock = false;
  discoveryEvents.removeAllListeners();
}

export { VIGIL_AGENTS };
