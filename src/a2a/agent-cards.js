import axios from 'axios';
import { createLogger } from '../utils/logger.js';

const log = createLogger('a2a-agent-cards');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

if (!KIBANA_URL || !ELASTIC_API_KEY) {
  throw new Error(
    'Missing required environment variables: ' +
    [!KIBANA_URL && 'KIBANA_URL', !ELASTIC_API_KEY && 'ELASTIC_API_KEY'].filter(Boolean).join(', ')
  );
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map();

export class AgentUnavailableError extends Error {
  constructor(agentId, reason, statusCode) {
    super(`Agent '${agentId}' is unavailable: ${reason}`);
    this.name = 'AgentUnavailableError';
    this.agentId = agentId;
    this.statusCode = statusCode ?? null;
  }
}

export async function getAgentCard(agentId) {
  // Check cache
  const cached = cache.get(agentId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.card;
  }

  try {
    const resp = await axios.get(
      `${KIBANA_URL}/api/agent_builder/a2a/${agentId}.json`,
      {
        headers: {
          'kbn-xsrf': 'true',
          'Authorization': `ApiKey ${ELASTIC_API_KEY}`
        },
        timeout: 10000
      }
    );

    const card = resp.data;
    cache.set(agentId, { card, fetchedAt: Date.now() });
    log.debug(`Fetched agent card for ${agentId}`);
    return card;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      throw new AgentUnavailableError(agentId, 'agent card not found (404)', 404);
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new AgentUnavailableError(agentId, 'request timed out', status);
    }
    throw new AgentUnavailableError(agentId, err.message, status);
  }
}

export function clearCache() {
  cache.clear();
}
