import 'dotenv/config';
import axios from 'axios';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('register-search-tools');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

const TOOLS_DIR = join(__dirname, '..', '..', 'src', 'tools', 'search');

const VALID_STRATEGIES = ['keyword', 'hybrid', 'knn'];

/**
 * Validate a search tool definition before registration.
 * Throws on invalid definitions.
 */
function validateToolDefinition(definition, fileName) {
  if (!definition.name) {
    throw new Error(`${fileName}: missing 'name' field`);
  }
  if (definition.type !== 'search') {
    throw new Error(`${fileName}: type must be 'search', got '${definition.type}'`);
  }
  if (!definition.index) {
    throw new Error(`${fileName}: missing 'index' field`);
  }
  if (!VALID_STRATEGIES.includes(definition.retrieval_strategy)) {
    throw new Error(
      `${fileName}: retrieval_strategy must be one of ${VALID_STRATEGIES.join(', ')}, got '${definition.retrieval_strategy}'`
    );
  }
  if (!Array.isArray(definition.result_fields) || definition.result_fields.length === 0) {
    throw new Error(`${fileName}: result_fields must be a non-empty array`);
  }

  // Strategy-specific validation
  const strategy = definition.retrieval_strategy;

  if (strategy === 'keyword') {
    if (!Array.isArray(definition.query_fields) || definition.query_fields.length === 0) {
      throw new Error(`${fileName}: keyword strategy requires non-empty 'query_fields' array`);
    }
  }

  if (strategy === 'hybrid') {
    if (!definition.text_field) {
      throw new Error(`${fileName}: hybrid strategy requires 'text_field'`);
    }
    if (!definition.vector_field) {
      throw new Error(`${fileName}: hybrid strategy requires 'vector_field'`);
    }
  }

  if (strategy === 'knn') {
    if (!definition.vector_field) {
      throw new Error(`${fileName}: knn strategy requires 'vector_field'`);
    }
  }
}

/**
 * Build the API registration payload from a flat tool definition.
 * Wraps strategy-specific fields inside a `config` object and strips
 * internal metadata fields (`agent`, `tags`).
 */
function buildPayload(definition) {
  const config = {
    description: definition.description,
    index: definition.index,
    retrieval_strategy: definition.retrieval_strategy,
    result_fields: definition.result_fields,
    max_results: definition.max_results
  };

  // Strategy-specific config fields
  if (definition.query_fields) config.query_fields = definition.query_fields;
  if (definition.text_field) config.text_field = definition.text_field;
  if (definition.vector_field) config.vector_field = definition.vector_field;
  if (definition.filter) config.filter = definition.filter;
  if (definition.min_score != null) config.min_score = definition.min_score;

  return {
    name: definition.name,
    type: 'search',
    config
  };
}

/**
 * Register a single search tool with the Agent Builder API.
 */
async function registerTool(payload) {
  const resp = await axios.post(
    `${KIBANA_URL}/api/agent_builder/tools`,
    payload,
    {
      headers: {
        'kbn-xsrf': 'true',
        'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return { status: 'registered', name: resp.data.name || payload.name };
}

async function run() {
  if (!KIBANA_URL) {
    log.error('KIBANA_URL is required');
    process.exit(1);
  }
  if (!ELASTIC_API_KEY) {
    log.error('ELASTIC_API_KEY is required');
    process.exit(1);
  }

  // Discover all JSON tool definitions
  const files = (await readdir(TOOLS_DIR))
    .filter(f => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    log.error(`No JSON tool definitions found in ${TOOLS_DIR}`);
    process.exit(1);
  }

  log.info(`Found ${files.length} search tool definitions`);

  const results = { registered: 0, skipped: 0, failed: 0 };
  let apiAvailable = true;

  for (const file of files) {
    const filePath = join(TOOLS_DIR, file);
    let definition;

    // Parse JSON
    try {
      const raw = await readFile(filePath, 'utf-8');
      definition = JSON.parse(raw);
    } catch (err) {
      log.error(`Failed to parse ${file}: ${err.message}`);
      results.failed++;
      continue;
    }

    // Validate
    try {
      validateToolDefinition(definition, file);
    } catch (err) {
      log.error(`Validation failed: ${err.message}`);
      results.failed++;
      continue;
    }

    // Skip remaining if API is unavailable
    if (!apiAvailable) {
      log.warn(`Skipping ${definition.name} (API unavailable)`);
      results.skipped++;
      continue;
    }

    const payload = buildPayload(definition);

    try {
      const result = await registerTool(payload);
      log.info(`Registered tool: ${result.name}`);
      results.registered++;
    } catch (err) {
      if (err.response?.status === 409) {
        log.warn(`Tool already exists: ${definition.name}`);
        results.skipped++;
      } else if (err.response?.status === 404) {
        log.warn(
          `Agent Builder API not available (404). Skipping remaining tools. ` +
          `Requires Elastic 9.x with Agent Builder enabled.`
        );
        apiAvailable = false;
        results.skipped++;
      } else {
        log.error(
          `Failed to register ${definition.name}: ${err.response?.status || ''} ${err.message}`
        );
        results.failed++;
      }
    }
  }

  // Summary
  log.info(
    `Registration complete: ${results.registered} registered, ` +
    `${results.skipped} skipped, ${results.failed} failed`
  );

  if (results.failed > 0) {
    process.exit(1);
  }
}

run();
