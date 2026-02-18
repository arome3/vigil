import 'dotenv/config';
import axios from 'axios';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('register-esql-tools');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

const TOOLS_DIR = join(__dirname, '..', '..', 'src', 'tools', 'esql');

/**
 * Extract all ?paramName tokens from an ES|QL query string.
 * Returns a Set of parameter names referenced in the query.
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
 * Validate a tool definition before registration.
 * Throws on invalid definitions.
 */
function validateToolDefinition(definition, fileName) {
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

  // Every ?param in the query must have a declaration
  for (const param of queryParams) {
    if (!declaredParams.has(param)) {
      throw new Error(
        `${fileName}: query references ?${param} but it is not declared in configuration.params`
      );
    }
  }

  // Every declared param should be referenced in the query (warn, don't fail)
  for (const param of declaredParams) {
    if (!queryParams.has(param)) {
      log.warn(`${fileName}: parameter '${param}' is declared but not referenced in the query`);
    }
  }
}

/**
 * Prepare the registration payload by stripping non-API fields.
 */
function preparePayload(definition) {
  const payload = { ...definition };
  // 'agent' is our metadata — not part of the Agent Builder API schema
  delete payload.agent;
  // 'lookupJoinTechPreview' is our internal flag
  delete payload.lookupJoinTechPreview;
  return payload;
}

/**
 * Register a single tool with the Agent Builder API.
 * Returns: 'registered' | 'skipped' | 'unavailable'
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
  return { status: 'registered', id: resp.data.id || payload.id };
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

  log.info(`Found ${files.length} ES|QL tool definitions`);

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

    // Register
    if (!apiAvailable) {
      log.warn(`Skipping ${definition.id} (API unavailable)`);
      results.skipped++;
      continue;
    }

    const payload = preparePayload(definition);

    try {
      const result = await registerTool(payload);
      log.info(`Registered tool: ${result.id}`);
      results.registered++;
    } catch (err) {
      if (err.response?.status === 409) {
        log.warn(`Tool already exists: ${definition.id}`);
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
          `Failed to register ${definition.id}: ${err.response?.status || ''} ${err.message}`
        );
        results.failed++;
        throw err;
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
