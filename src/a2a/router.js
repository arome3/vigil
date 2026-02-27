import axios from 'axios';
import { validateEnvelope } from './message-envelope.js';
import { getAgentCard, AgentUnavailableError } from './agent-cards.js';
import { createLogger } from '../utils/logger.js';
import client from '../utils/elastic-client.js';
import {
  handleContainment,
  handleRemediation,
  handleNotify,
  handleTicketing,
  handleApproval,
  handleReporting
} from './workflow-handlers.js';

const log = createLogger('a2a-router');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

if (!KIBANA_URL || !ELASTIC_API_KEY) {
  throw new Error(
    'Missing required environment variables: ' +
    [!KIBANA_URL && 'KIBANA_URL', !ELASTIC_API_KEY && 'ELASTIC_API_KEY'].filter(Boolean).join(', ')
  );
}

// Per-agent timeouts (milliseconds) — docs/14-a2a-protocol.md
export const A2A_TIMEOUTS = Object.freeze({
  'vigil-triage':         10_000,
  'vigil-investigator':   60_000,
  'vigil-threat-hunter':  90_000,
  'vigil-sentinel':      180_000,
  'vigil-commander':      45_000,
  'vigil-executor':      300_000,
  'vigil-verifier':      120_000,
  'vigil-wf-containment':  30_000,
  'vigil-wf-remediation': 120_000,
  'vigil-wf-notify':       30_000,
  'vigil-wf-ticketing':    30_000,
  'vigil-wf-approval':     30_000,
  'vigil-wf-reporting':    60_000
});

const DEFAULT_TIMEOUT = 60_000;

// ── Local handler registry (fallback when Agent Builder is unavailable) ──

const LOCAL_HANDLERS = {};
let localHandlersLoaded = false;

async function loadLocalHandlers() {
  if (localHandlersLoaded) return;
  try {
    const [triage, investigator, threatHunter, commander, executor, verifier] =
      await Promise.allSettled([
        import('../agents/triage/handler.js'),
        import('../agents/investigator/handler.js'),
        import('../agents/threat-hunter/handler.js'),
        import('../agents/commander/handler.js'),
        import('../agents/executor/handler.js'),
        import('../agents/verifier/handler.js')
      ]);

    if (triage.status === 'fulfilled') LOCAL_HANDLERS['vigil-triage'] = triage.value.handleTriageRequest;
    if (investigator.status === 'fulfilled') LOCAL_HANDLERS['vigil-investigator'] = investigator.value.handleInvestigateRequest;
    if (threatHunter.status === 'fulfilled') LOCAL_HANDLERS['vigil-threat-hunter'] = threatHunter.value.handleSweepRequest;
    if (commander.status === 'fulfilled') LOCAL_HANDLERS['vigil-commander'] = commander.value.handlePlanRequest;
    if (executor.status === 'fulfilled') LOCAL_HANDLERS['vigil-executor'] = executor.value.handleExecutePlan;
    if (verifier.status === 'fulfilled') LOCAL_HANDLERS['vigil-verifier'] = verifier.value.handleVerifyRequest;

    // Workflow handlers — call real integrations when credentials are
    // available, fall back to mock when they're not.
    LOCAL_HANDLERS['vigil-wf-containment'] = handleContainment;
    LOCAL_HANDLERS['vigil-wf-remediation'] = handleRemediation;
    LOCAL_HANDLERS['vigil-wf-notify'] = handleNotify;
    LOCAL_HANDLERS['vigil-wf-ticketing'] = handleTicketing;
    LOCAL_HANDLERS['vigil-wf-approval'] = handleApproval;
    LOCAL_HANDLERS['vigil-wf-reporting'] = handleReporting;

    const loaded = Object.keys(LOCAL_HANDLERS);
    log.info(`Local fallback handlers loaded: ${loaded.join(', ')} (${loaded.length} total)`);
  } catch (err) {
    log.warn(`Failed to load local handlers: ${err.message}`);
  }
  localHandlersLoaded = true;
}

// Track whether Agent Builder is reachable — avoid repeated failed requests
let agentBuilderAvailable = null; // null = unknown, true/false = cached result
let agentBuilderCheckedAt = 0;
const AGENT_BUILDER_CHECK_TTL_MS = 60_000; // re-check every 60s

// ── Retry helper for transient HTTP failures ────────────────

const MAX_RETRIES = 1;
const BASE_DELAY_MS = 500;

function isTransientHttpError(err) {
  const status = err.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES || !isTransientHttpError(err)) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
      log.warn(`${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── Error classes ───────────────────────────────────────────

export class AgentTimeoutError extends Error {
  constructor(agentId, timeoutMs) {
    super(`Agent '${agentId}' timed out after ${timeoutMs}ms`);
    this.name = 'AgentTimeoutError';
    this.agentId = agentId;
    this.timeoutMs = timeoutMs;
  }
}

export class A2AError extends Error {
  constructor(agentId, message, statusCode) {
    super(`A2A error from '${agentId}': ${message}`);
    this.name = 'A2AError';
    this.agentId = agentId;
    this.statusCode = statusCode;
  }
}

// ── Local handler execution ─────────────────────────────────

async function executeLocalHandler(agentId, envelope) {
  await loadLocalHandlers();

  const handler = LOCAL_HANDLERS[agentId];
  if (!handler) {
    throw new A2AError(agentId, `No local handler available for '${agentId}'`);
  }

  log.info(`Routing ${agentId} via local handler (Agent Builder unavailable)`);
  return handler(envelope.payload);
}

// ── Main send function ──────────────────────────────────────

export async function sendA2AMessage(agentId, envelope, options = {}) {
  validateEnvelope(envelope);

  const startTime = Date.now();
  let status = 'success';
  let responseData;

  try {
    // Local handlers run deterministic logic (ES|QL queries, scoring, plan building)
    // that produces contract-compliant responses. Agent Builder's A2A endpoint uses
    // LLM inference which doesn't guarantee contract compliance.
    // Use local handlers by default; Agent Builder A2A can be enabled via env var
    // for future LLM-based agent execution.
    const useAgentBuilderA2A = process.env.VIGIL_USE_AGENT_BUILDER_A2A === 'true';

    if (!useAgentBuilderA2A) {
      responseData = await executeLocalHandler(agentId, envelope);
      status = 'success_local';
    } else {
      try {
        const card = await getAgentCard(agentId);

        const task = envelope.payload?.task;
        if (task && card.capabilities?.length) {
          const supported = card.capabilities.some(
            (cap) => (typeof cap === 'string' ? cap === task : cap.task === task)
          );
          if (!supported) {
            throw new A2AError(agentId, `agent does not support task '${task}'`);
          }
        }

        const timeout = options.timeout || A2A_TIMEOUTS[agentId] || DEFAULT_TIMEOUT;

        const resp = await withRetry(
          () => axios.post(
            `${KIBANA_URL}/api/agent_builder/a2a/${agentId}`,
            envelope,
            {
              headers: {
                'kbn-xsrf': 'true',
                'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
                'Content-Type': 'application/json'
              },
              timeout
            }
          ),
          `a2a-send(${agentId})`
        );

        responseData = resp.data;
      } catch (err) {
        if (err instanceof AgentUnavailableError) {
          log.warn(`Agent Builder unavailable for ${agentId}, falling back to local handler`);
          responseData = await executeLocalHandler(agentId, envelope);
          status = 'success_local';
        } else if (err instanceof AgentTimeoutError || err instanceof A2AError) {
          status = err instanceof AgentTimeoutError ? 'timeout' : 'error';
          throw err;
        } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
          status = 'timeout';
          throw new AgentTimeoutError(agentId, options.timeout || A2A_TIMEOUTS[agentId] || DEFAULT_TIMEOUT);
        } else {
          status = 'error';
          throw new A2AError(
            agentId,
            err.response?.data?.message || err.message,
            err.response?.status
          );
        }
      }
    }
  } catch (err) {
    status = status === 'success' ? 'error' : status;
    throw err;
  } finally {
    const executionTimeMs = Date.now() - startTime;

    // Log telemetry — never throws to caller
    try {
      await client.index({
        index: 'vigil-agent-telemetry',
        document: {
          '@timestamp': new Date().toISOString(),
          agent_name: agentId,
          incident_id: envelope.correlation_id,
          message_id: envelope.message_id,
          from_agent: envelope.from_agent,
          execution_time_ms: executionTimeMs,
          status,
          task: envelope.payload?.task || null
        }
      });
    } catch (telemetryErr) {
      log.error(`Failed to log telemetry for ${agentId}: ${telemetryErr.message}`);
    }

    log.info(
      `A2A ${envelope.from_agent} → ${agentId}: ${status} (${executionTimeMs}ms)`
    );
  }

  return responseData;
}
