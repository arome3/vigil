import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('hybrid-search');

// Vector field names to always strip from results
const VECTOR_FIELDS = [
  'investigation_summary_vector',
  'root_cause_vector',
  'content_vector',
  'description_vector'
];

function formatResults(hits) {
  return {
    results: hits.hits.map((hit) => {
      const source = { ...hit._source };
      for (const vf of VECTOR_FIELDS) delete source[vf];
      return { _id: hit._id, _score: hit._score, ...source };
    }),
    total: typeof hits.total === 'number' ? hits.total : hits.total?.value ?? 0
  };
}

// ── Pure kNN Search ─────────────────────────────────────────

export async function knnSearch(index, vectorField, queryVector, options = {}) {
  const {
    k = 5,
    numCandidates = 50,
    filter,
    minScore,
    sourceFields,
    size
  } = options;

  const knn = {
    field: vectorField,
    query_vector: queryVector,
    k,
    num_candidates: numCandidates
  };

  if (filter) knn.filter = filter;
  if (minScore != null) knn.similarity = minScore;

  const searchParams = {
    index,
    knn,
    size: size ?? k,
    _source: { excludes: VECTOR_FIELDS }
  };

  if (sourceFields) searchParams._source = { includes: sourceFields, excludes: VECTOR_FIELDS };

  const res = await client.search(searchParams);
  return formatResults(res.hits);
}

// ── Keyword + kNN Hybrid (RRF) ──────────────────────────────

export async function hybridSearch(index, textFields, vectorField, query, queryVector, options = {}) {
  const {
    k = 5,
    numCandidates = 50,
    filter,
    rankWindowSize = 25,
    rankConstant = 60,
    size = 5,
    sourceFields
  } = options;

  const knnRetriever = {
    knn: {
      field: vectorField,
      query_vector: queryVector,
      k,
      num_candidates: numCandidates
    }
  };
  if (filter) knnRetriever.knn.filter = filter;

  const standardRetriever = {
    standard: {
      query: {
        multi_match: {
          query,
          fields: textFields
        }
      }
    }
  };
  if (filter) standardRetriever.standard.query = { bool: { must: [{ multi_match: { query, fields: textFields } }], filter: [filter] } };

  const sourceConfig = sourceFields
    ? { includes: sourceFields, excludes: VECTOR_FIELDS }
    : { excludes: VECTOR_FIELDS };

  try {
    const res = await client.search({
      index,
      retriever: {
        rrf: {
          retrievers: [standardRetriever, knnRetriever],
          rank_window_size: rankWindowSize,
          rank_constant: rankConstant
        }
      },
      size,
      _source: sourceConfig
    });
    return formatResults(res.hits);
  } catch (err) {
    const errType = err.meta?.body?.error?.type || '';
    if (errType.includes('license') || errType.includes('x_content_parse_exception')) {
      log.warn('RRF not available (license/version), falling back to kNN search');
      return knnSearch(index, vectorField, queryVector, { k, numCandidates, filter, size, sourceFields });
    }
    throw err;
  }
}

// ── Three-Way Hybrid (BM25 + kNN + kNN via RRF) ────────────

export async function threeWayHybridSearch(
  index, textFields, vectorField, query, queryVector,
  semanticField, semanticVector, options = {}
) {
  const {
    k = 5,
    numCandidates = 50,
    filter,
    rankWindowSize = 25,
    rankConstant = 60,
    size = 5,
    sourceFields
  } = options;

  const standardRetriever = {
    standard: {
      query: filter
        ? { bool: { must: [{ multi_match: { query, fields: textFields } }], filter: [filter] } }
        : { multi_match: { query, fields: textFields } }
    }
  };

  const primaryKnn = {
    knn: {
      field: vectorField,
      query_vector: queryVector,
      k,
      num_candidates: numCandidates,
      ...(filter && { filter })
    }
  };

  const secondaryKnn = {
    knn: {
      field: semanticField,
      query_vector: semanticVector,
      k,
      num_candidates: numCandidates,
      ...(filter && { filter })
    }
  };

  const sourceConfig = sourceFields
    ? { includes: sourceFields, excludes: VECTOR_FIELDS }
    : { excludes: VECTOR_FIELDS };

  try {
    const res = await client.search({
      index,
      retriever: {
        rrf: {
          retrievers: [standardRetriever, primaryKnn, secondaryKnn],
          rank_window_size: rankWindowSize,
          rank_constant: rankConstant
        }
      },
      size,
      _source: sourceConfig
    });
    return formatResults(res.hits);
  } catch (err) {
    const errType = err.meta?.body?.error?.type || '';
    if (errType.includes('license') || errType.includes('x_content_parse_exception')) {
      log.warn('RRF not available (license/version), falling back to kNN search');
      return knnSearch(index, vectorField, queryVector, { k, numCandidates, filter, size, sourceFields });
    }
    throw err;
  }
}
