import axios from 'axios';
import { createEnvelope, validateEnvelope } from './message-envelope.js';
import { getAgentCard } from './agent-cards.js';
import { createLogger } from '../utils/logger.js';
import client from '../utils/elastic-client.js';

const log = createLogger('a2a-router');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

// Per-agent timeouts (milliseconds) — docs/14-a2a-protocol.md
export const A2A_TIMEOUTS = Object.freeze({
  'vigil-triage':         10_000,
  'vigil-investigator':   60_000,
  'vigil-threat-hunter':  90_000,
  'vigil-sentinel':      180_000,
  'vigil-commander':      45_000,
  'vigil-executor':      300_000,
  'vigil-verifier':      120_000,
  'vigil-wf-notify':      30_000,
  'vigil-wf-approval':    30_000
});

const DEFAULT_TIMEOUT = 60_000;

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

export async function sendA2AMessage(agentId, envelope, options = {}) {
  validateEnvelope(envelope);

  // Fetch agent card to verify availability
  await getAgentCard(agentId);

  const timeout = options.timeout || A2A_TIMEOUTS[agentId] || DEFAULT_TIMEOUT;
  const startTime = Date.now();
  let status = 'success';
  let responseData;

  try {
    const resp = await axios.post(
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
    );

    responseData = resp.data;
  } catch (err) {
    status = 'error';

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      status = 'timeout';
      throw new AgentTimeoutError(agentId, timeout);
    }

    throw new A2AError(
      agentId,
      err.response?.data?.message || err.message,
      err.response?.status
    );
  } finally {
    const executionTimeMs = Date.now() - startTime;

    // Log telemetry
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
