import 'dotenv/config';
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('register-analyst-tools');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

const ESQL_DIR = join(__dirname, '..', '..', 'src', 'tools', 'esql');
const SEARCH_DIR = join(__dirname, '..', '..', 'src', 'tools', 'search');

// Analyst-specific tool files
const ESQL_TOOLS = [
  'vigil-esql-incident-outcomes.json',
  'vigil-esql-triage-calibration.json',
  'vigil-esql-threshold-analysis.json',
  'vigil-esql-remediation-effectiveness.json'
];

const SEARCH_TOOLS = [
  'vigil-search-incident-patterns.json'
];

/**
 * Extract all ?paramName tokens from an ES|QL query string.
 */
function extractQueryParams(query) {
  const params = new Set();
  const regex = /\?(\w+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    params.add(match[1]);
  }
  return params;
}

/**
 * Validate an ES|QL tool definition.
 */
function validateEsqlTool(definition, fileName) {
  if (!definition.id) {
    throw new Error(`${fileName}: missing 'id' field`);
  }
  if (definition.type !== 'esql') {
    throw new Error(`${fileName}: type must be 'esql', got '${definition.type}'`);
  }
  if (!definition.configuration?.query) {
    throw new Error(`${fileName}: missing 'configuration.query'`);
  }

  const queryParams = extractQueryParams(definition.configuration.query);
  const declaredParams = new Set(Object.keys(definition.configuration.params || {}));

  for (const param of queryParams) {
    if (!declaredParams.has(param)) {
      throw new Error(
        `${fileName}: query references ?${param} but it is not declared in configuration.params`
      );
    }
  }

  for (const param of declaredParams) {
    if (!queryParams.has(param)) {
      log.warn(`${fileName}: parameter '${param}' is declared but not referenced in the query`);
    }
  }
}

/**
 * Validate a search tool definition.
 */
function validateSearchTool(definition, fileName) {
  if (!definition.name) {
    throw new Error(`${fileName}: missing 'name' field`);
  }
  if (definition.type !== 'search') {
    throw new Error(`${fileName}: type must be 'search', got '${definition.type}'`);
  }
  if (!definition.index) {
    throw new Error(`${fileName}: missing 'index' field`);
  }

  const strategy = definition.retrieval_strategy;
  if (!['keyword', 'hybrid', 'knn'].includes(strategy)) {
    throw new Error(`${fileName}: invalid retrieval_strategy '${strategy}'`);
  }
  if (strategy === 'hybrid') {
    if (!definition.text_field) throw new Error(`${fileName}: hybrid strategy requires 'text_field'`);
    if (!definition.vector_field) throw new Error(`${fileName}: hybrid strategy requires 'vector_field'`);
  }
}

/**
 * Build the registration payload for an ES|QL tool.
 */
function prepareEsqlPayload(definition) {
  const payload = { ...definition };
  delete payload.agent;
  delete payload.lookupJoinTechPreview;
  return payload;
}

/**
 * Build the registration payload for a search tool.
 */
function buildSearchPayload(definition) {
  const config = {
    description: definition.description,
    index: definition.index,
    retrieval_strategy: definition.retrieval_strategy,
    result_fields: definition.result_fields,
    max_results: definition.max_results
  };

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
 * Register a single tool with the Agent Builder API.
 * Retries once on 5xx errors with a 2s delay.
 */
async function registerTool(payload, retries = 1) {
  try {
    return await axios.post(
      `${KIBANA_URL}/api/agent_builder/tools`,
      payload,
      {
        headers: {
          'kbn-xsrf': 'true',
          'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
  } catch (err) {
    const status = err.response?.status;
    if (retries > 0 && status >= 500 && status < 600) {
      log.warn(`Server error ${status} registering tool, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      return registerTool(payload, retries - 1);
    }
    throw err;
  }
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

  const results = { registered: 0, skipped: 0, failed: 0 };
  let apiAvailable = true;

  // --- ES|QL tools ---
  for (const file of ESQL_TOOLS) {
    const filePath = join(ESQL_DIR, file);
    let definition;

    try {
      const raw = await readFile(filePath, 'utf-8');
      definition = JSON.parse(raw);
    } catch (err) {
      log.error(`Failed to parse ${file}: ${err.message}`);
      results.failed++;
      continue;
    }

    try {
      validateEsqlTool(definition, file);
    } catch (err) {
      log.error(`Validation failed: ${err.message}`);
      results.failed++;
      continue;
    }

    if (!apiAvailable) {
      log.warn(`Skipping ${definition.id} (API unavailable)`);
      results.skipped++;
      continue;
    }

    const payload = prepareEsqlPayload(definition);

    try {
      await registerTool(payload);
      log.info(`Registered ES|QL tool: ${definition.id}`);
      results.registered++;
    } catch (err) {
      if (err.response?.status === 409) {
        log.warn(`Tool already exists: ${definition.id}`);
        results.skipped++;
      } else if (err.response?.status === 404) {
        log.warn('Agent Builder API not available (404). Skipping remaining tools.');
        apiAvailable = false;
        results.failed++;
      } else {
        log.error(`Failed to register ${definition.id}: ${err.response?.status || ''} ${err.message}`);
        results.failed++;
      }
    }
  }

  // --- Search tools ---
  for (const file of SEARCH_TOOLS) {
    const filePath = join(SEARCH_DIR, file);
    let definition;

    try {
      const raw = await readFile(filePath, 'utf-8');
      definition = JSON.parse(raw);
    } catch (err) {
      log.error(`Failed to parse ${file}: ${err.message}`);
      results.failed++;
      continue;
    }

    try {
      validateSearchTool(definition, file);
    } catch (err) {
      log.error(`Validation failed: ${err.message}`);
      results.failed++;
      continue;
    }

    if (!apiAvailable) {
      log.warn(`Skipping ${definition.name} (API unavailable)`);
      results.skipped++;
      continue;
    }

    const payload = buildSearchPayload(definition);

    try {
      await registerTool(payload);
      log.info(`Registered search tool: ${definition.name}`);
      results.registered++;
    } catch (err) {
      if (err.response?.status === 409) {
        log.warn(`Tool already exists: ${definition.name}`);
        results.skipped++;
      } else if (err.response?.status === 404) {
        log.warn('Agent Builder API not available (404). Skipping remaining tools.');
        apiAvailable = false;
        results.failed++;
      } else {
        log.error(`Failed to register ${definition.name}: ${err.response?.status || ''} ${err.message}`);
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
