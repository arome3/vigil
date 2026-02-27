import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('esql-executor');

const TOOLS_DIR = __dirname;
const DEFAULT_TIMEOUT = 30_000;

/**
 * Load and parse a tool definition JSON file.
 *
 * @param {string} toolName - Tool ID (e.g. 'vigil-esql-alert-enrichment')
 * @returns {Promise<object>} Parsed tool definition
 */
export async function loadToolDefinition(toolName) {
  const filePath = join(TOOLS_DIR, `${toolName}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Tool definition not found: ${toolName}`);
    }
    throw new Error(`Failed to load tool definition ${toolName}: ${err.message}`);
  }
}

/**
 * Validate provided parameters against the tool definition.
 * Applies defaults for missing optional parameters.
 *
 * @param {object} definition - Tool definition object
 * @param {object} params - Provided parameter values
 * @returns {object} Validated and defaulted parameter values
 * @throws {Error} If required params are missing or types are invalid
 */
export function validateParams(definition, params) {
  const declaredParams = definition.configuration.params || {};
  const validated = {};

  for (const [name, schema] of Object.entries(declaredParams)) {
    const value = params[name];

    if (value === undefined || value === null) {
      if (schema.required) {
        throw new Error(
          `Missing required parameter '${name}' for tool '${definition.id}'`
        );
      }
      // Apply default if defined
      if (schema.default !== undefined) {
        validated[name] = schema.default;
      }
      continue;
    }

    // Type coercion based on declared type
    validated[name] = coerceParam(name, value, schema.type);
  }

  return validated;
}

/**
 * Coerce a parameter value to the declared ES|QL type.
 *
 * @param {string} name - Parameter name
 * @param {*} value - Raw value
 * @param {string} type - Declared type (keyword, integer, double, date)
 * @returns {*} Coerced value
 */
function coerceParam(name, value, type) {
  switch (type) {
    case 'keyword':
      // Arrays and strings are both valid for keyword (IN clauses use arrays)
      if (Array.isArray(value)) return value;
      return String(value);

    case 'integer': {
      const num = Number(value);
      if (!Number.isInteger(num)) {
        throw new Error(`Parameter '${name}' must be an integer, got '${value}'`);
      }
      return num;
    }

    case 'double': {
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`Parameter '${name}' must be a number, got '${value}'`);
      }
      return num;
    }

    case 'ip':
      // Accept strings and arrays of strings (for IN clauses)
      if (Array.isArray(value)) return value.map(v => String(v));
      return String(value);

    case 'date':
      // Accept ISO 8601 strings and Date objects
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
      throw new Error(`Parameter '${name}' must be a valid date, got '${value}'`);

    default:
      return value;
  }
}

/**
 * Expand array parameters in an ES|QL query.
 *
 * ES|QL's parameterized `IN (?param)` doesn't accept array values natively.
 * This function rewrites `?param` → `?param_0, ?param_1, ...` in the query
 * and splits the array into individual named params.
 *
 * @param {string} query - Original ES|QL query with ?param placeholders
 * @param {object} validatedParams - Validated parameter key-value pairs
 * @returns {{ query: string, params: object }} Rewritten query and expanded params
 */
function expandArrayParams(query, validatedParams) {
  const expandedParams = {};
  let rewrittenQuery = query;

  for (const [name, value] of Object.entries(validatedParams)) {
    if (Array.isArray(value)) {
      // Build individual param names: ?name_0, ?name_1, ...
      const paramNames = value.map((_, i) => `?${name}_${i}`);
      // Replace ?name with ?name_0, ?name_1, ... in the query
      rewrittenQuery = rewrittenQuery.replace(
        new RegExp(`\\?${name}\\b`, 'g'),
        paramNames.join(', ')
      );
      // Add individual params
      for (let i = 0; i < value.length; i++) {
        expandedParams[`${name}_${i}`] = value[i];
      }
    } else {
      expandedParams[name] = value;
    }
  }

  return { query: rewrittenQuery, params: expandedParams };
}

/**
 * Build the ES|QL params array from validated parameter values.
 * ES|QL expects: [{ paramName: value }, { paramName2: value2 }, ...]
 *
 * @param {object} validatedParams - Validated parameter key-value pairs
 * @returns {Array<object>} ES|QL params array
 */
function buildEsqlParams(validatedParams) {
  return Object.entries(validatedParams).map(([name, value]) => ({ [name]: value }));
}

/**
 * Execute a parameterized ES|QL tool query against Elasticsearch.
 *
 * Values are NEVER concatenated into the query string — they are passed
 * via the separate `params` array, which is ES|QL's built-in injection prevention.
 *
 * @param {string} toolName - Tool ID (e.g. 'vigil-esql-alert-enrichment')
 * @param {object} params - Parameter values keyed by param name
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=30000] - Query timeout in milliseconds
 * @returns {Promise<{ columns: Array, values: Array, took: number }>}
 */
export async function executeEsqlTool(toolName, params = {}, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  // Load and validate
  const definition = await loadToolDefinition(toolName);
  const validatedParams = validateParams(definition, params);

  log.info(`Executing tool: ${definition.id} with ${Object.keys(validatedParams).length} params`);

  // Expand array params (e.g. IN (?ips) → IN (?ips_0, ?ips_1)) and build request body
  const { query: expandedQuery, params: expandedParams } =
    expandArrayParams(definition.configuration.query, validatedParams);
  const esqlParams = buildEsqlParams(expandedParams);
  const body = { query: expandedQuery };
  if (esqlParams.length > 0) {
    body.params = esqlParams;
  }

  try {
    const response = await client.transport.request(
      {
        method: 'POST',
        path: '/_query',
        body
      },
      {
        requestTimeout: timeout,
        meta: true
      }
    );

    const result = response.body;
    const took = result.took ?? 0;
    const columns = result.columns || [];
    const values = result.values || [];

    log.info(
      `Tool ${definition.id}: ${values.length} rows, ${columns.length} columns, took ${took}ms`
    );

    return { columns, values, took };
  } catch (err) {
    // If this tool uses LOOKUP JOIN (tech preview) and the query failed,
    // try the fallback module
    if (definition.lookupJoinTechPreview && isLookupJoinError(err)) {
      log.warn(
        `LOOKUP JOIN not available for ${definition.id}, falling back to two-query approach`
      );
      const { executeChangeCorrelationFallback } = await import(
        './change-correlation-fallback.js'
      );
      return executeChangeCorrelationFallback(validatedParams, { timeout });
    }

    // Rethrow with context
    const status = err.meta?.statusCode || err.statusCode || 'unknown';
    const reason = err.meta?.body?.error?.reason || err.message;
    throw new Error(
      `ES|QL query failed for ${definition.id} (status ${status}): ${reason}`
    );
  }
}

/**
 * Detect whether an error is caused by unsupported LOOKUP JOIN syntax.
 */
function isLookupJoinError(err) {
  const message = (
    err.meta?.body?.error?.reason ||
    err.message ||
    ''
  ).toLowerCase();

  return (
    message.includes('lookup join') ||
    message.includes('lookup_join') ||
    message.includes('unknown command [lookup]') ||
    message.includes('parsing_exception')
  );
}
