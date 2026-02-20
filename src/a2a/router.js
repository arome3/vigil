import axios from 'axios';
import { createEnvelope, validateEnvelope } from './message-envelope.js';
import { getAgentCard, AgentUnavailableError } from './agent-cards.js';
import { createLogger } from '../utils/logger.js';
import client from '../utils/elastic-client.js';

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

// ── Main send function ──────────────────────────────────────

export async function sendA2AMessage(agentId, envelope, options = {}) {
  validateEnvelope(envelope);

  const startTime = Date.now();
  let status = 'success';
  let responseData;

  try {
    // Fetch agent card to verify availability + check capabilities
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
    // Let known error types pass through without re-wrapping
    if (err instanceof AgentUnavailableError) {
      status = 'card_unavailable';
      throw err;
    }
    if (err instanceof AgentTimeoutError || err instanceof A2AError) {
      status = err instanceof AgentTimeoutError ? 'timeout' : 'error';
      throw err;
    }

    status = 'error';

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      status = 'timeout';
      throw new AgentTimeoutError(agentId, options.timeout || A2A_TIMEOUTS[agentId] || DEFAULT_TIMEOUT);
    }

    throw new A2AError(
      agentId,
      err.response?.data?.message || err.message,
      err.response?.status
    );
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
