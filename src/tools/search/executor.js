import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { embedText } from '../../embeddings/embedding-service.js';
import { hybridSearch, knnSearch } from '../../search/hybrid-search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('search-executor');

const TOOLS_DIR = __dirname;

/**
 * Load and parse a search tool definition JSON file.
 *
 * @param {string} toolName - Tool name (e.g. 'vigil-search-asset-criticality')
 * @returns {Promise<object>} Parsed tool definition
 */
export async function loadSearchToolDefinition(toolName) {
  const filePath = join(TOOLS_DIR, `${toolName}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Search tool definition not found: ${toolName}`);
    }
    throw new Error(`Failed to load search tool definition ${toolName}: ${err.message}`);
  }
}

/**
 * Execute a keyword search using multi_match with optional filter.
 *
 * @param {object} definition - Tool definition
 * @param {string} query - Search query text
 * @returns {Promise<{ results: Array, total: number, took: number }>}
 */
async function executeKeywordSearch(definition, query) {
  const multiMatch = {
    multi_match: {
      query,
      fields: definition.query_fields
    }
  };

  const queryBody = definition.filter
    ? { bool: { must: [multiMatch], filter: [definition.filter] } }
    : multiMatch;

  const response = await client.search({
    index: definition.index,
    query: queryBody,
    size: definition.max_results,
    _source: { includes: definition.result_fields }
  });

  return formatResponse(response, definition);
}

/**
 * Execute a hybrid search (BM25 + kNN with RRF) via the hybrid-search module.
 *
 * @param {object} definition - Tool definition
 * @param {string} query - Search query text
 * @returns {Promise<{ results: Array, total: number, took: number }>}
 */
async function executeHybridSearch(definition, query) {
  const queryVector = await embedText(query);
  const maxResults = definition.max_results;
  const numCandidates = Math.min(maxResults * 10, 100);

  const result = await hybridSearch(
    definition.index,
    [definition.text_field],
    definition.vector_field,
    query,
    queryVector,
    {
      k: maxResults,
      numCandidates,
      filter: definition.filter,
      rankWindowSize: 25,
      rankConstant: 60,
      size: maxResults,
      sourceFields: definition.result_fields
    }
  );

  return {
    results: filterResultFields(result.results, definition.result_fields).slice(0, maxResults),
    total: result.total,
    took: 0
  };
}

/**
 * Execute a pure kNN vector search via the hybrid-search module.
 *
 * @param {object} definition - Tool definition
 * @param {string} query - Search query text
 * @returns {Promise<{ results: Array, total: number, took: number }>}
 */
async function executeKnnSearch(definition, query) {
  const queryVector = await embedText(query);
  const maxResults = definition.max_results;
  const numCandidates = Math.min(maxResults * 10, 100);

  const result = await knnSearch(
    definition.index,
    definition.vector_field,
    queryVector,
    {
      k: maxResults,
      numCandidates,
      filter: definition.filter,
      minScore: definition.min_score,
      size: maxResults,
      sourceFields: definition.result_fields
    }
  );

  return {
    results: filterResultFields(result.results, definition.result_fields).slice(0, maxResults),
    total: result.total,
    took: 0
  };
}

/**
 * Format raw Elasticsearch response into the standard return shape.
 * Used by keyword search which calls client.search directly.
 *
 * @param {object} response - Raw ES client response
 * @param {object} definition - Tool definition
 * @returns {{ results: Array, total: number, took: number }}
 */
function formatResponse(response, definition) {
  const hits = response.hits.hits || [];
  const total = typeof response.hits.total === 'number'
    ? response.hits.total
    : response.hits.total?.value ?? 0;
  const took = response.took ?? 0;

  const results = hits.map(hit => {
    const source = hit._source || {};
    const filtered = {};
    for (const field of definition.result_fields) {
      if (source[field] !== undefined) {
        filtered[field] = source[field];
      }
    }
    return { _id: hit._id, _score: hit._score, ...filtered };
  });

  return { results: results.slice(0, definition.max_results), total, took };
}

/**
 * Defensively filter each result object to only include declared result_fields
 * plus the _id and _score metadata added by hybrid-search.js.
 *
 * @param {Array} results - Result objects from hybrid-search module
 * @param {string[]} resultFields - Allowed field names
 * @returns {Array} Filtered results
 */
function filterResultFields(results, resultFields) {
  const allowedSet = new Set(resultFields);
  return results.map(result => {
    const filtered = {};
    // Preserve search metadata
    if (result._id !== undefined) filtered._id = result._id;
    if (result._score !== undefined) filtered._score = result._score;
    // Include only declared result fields
    for (const field of allowedSet) {
      if (result[field] !== undefined) {
        filtered[field] = result[field];
      }
    }
    return filtered;
  });
}

/**
 * Execute a search tool query by name and query string.
 *
 * Loads the tool definition, routes to the correct retrieval strategy,
 * and returns structured results.
 *
 * @param {string} toolName - Tool name (e.g. 'vigil-search-asset-criticality')
 * @param {string} query - Search query text
 * @param {object} [options] - Reserved for future use
 * @returns {Promise<{ results: Array, total: number, took: number }>}
 */
export async function executeSearchTool(toolName, query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('query must be a non-empty string');
  }

  const definition = await loadSearchToolDefinition(toolName);

  log.info(`Executing search tool: ${definition.name} [${definition.retrieval_strategy}]`);

  const startTime = Date.now();
  let result;

  switch (definition.retrieval_strategy) {
    case 'keyword':
      result = await executeKeywordSearch(definition, query);
      break;
    case 'hybrid':
      result = await executeHybridSearch(definition, query);
      break;
    case 'knn':
      result = await executeKnnSearch(definition, query);
      break;
    default:
      throw new Error(
        `Unknown retrieval_strategy '${definition.retrieval_strategy}' in tool ${definition.name}`
      );
  }

  const elapsed = Date.now() - startTime;
  // Use actual took from ES if available, otherwise wall-clock time
  if (result.took === 0) result.took = elapsed;

  log.info(
    `Tool ${definition.name}: ${result.results.length} results, ` +
    `total ${result.total}, took ${result.took}ms`
  );

  return result;
}
