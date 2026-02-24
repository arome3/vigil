import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock setup ─────────────────────────────────────────────

const mockReadFile = mock.fn();
const mockClientSearch = mock.fn();
const mockEmbedText = mock.fn();
const mockHybridSearch = mock.fn();
const mockKnnSearch = mock.fn();

mock.module('node:fs/promises', {
  namedExports: {
    readFile: mockReadFile
  }
});

mock.module(import.meta.resolve('../../../../src/utils/elastic-client.js'), {
  defaultExport: {
    search: mockClientSearch
  }
});

mock.module(import.meta.resolve('../../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    })
  }
});

mock.module(import.meta.resolve('../../../../src/embeddings/embedding-service.js'), {
  namedExports: {
    embedText: mockEmbedText
  }
});

mock.module(import.meta.resolve('../../../../src/search/hybrid-search.js'), {
  namedExports: {
    hybridSearch: mockHybridSearch,
    knnSearch: mockKnnSearch
  }
});

// ─── Import module under test (after mocks) ─────────────────

const { loadSearchToolDefinition, executeSearchTool } =
  await import('../../../../src/tools/search/executor.js');

// ─── Helpers ────────────────────────────────────────────────

function createKeywordDefinition(overrides = {}) {
  return {
    name: 'test-keyword-tool',
    retrieval_strategy: 'keyword',
    index: 'test-index',
    query_fields: ['name', 'description'],
    result_fields: ['name', 'criticality', 'owner'],
    max_results: 10,
    ...overrides
  };
}

function createHybridDefinition(overrides = {}) {
  return {
    name: 'test-hybrid-tool',
    retrieval_strategy: 'hybrid',
    index: 'test-vectors',
    text_field: 'description',
    vector_field: 'description_embedding',
    query_fields: ['description'],
    result_fields: ['title', 'technique_id', 'description'],
    max_results: 5,
    ...overrides
  };
}

function createKnnDefinition(overrides = {}) {
  return {
    name: 'test-knn-tool',
    retrieval_strategy: 'knn',
    index: 'test-embeddings',
    vector_field: 'embedding',
    result_fields: ['title', 'content'],
    max_results: 5,
    min_score: 0.7,
    ...overrides
  };
}

function setupMockDefinition(def) {
  mockReadFile.mock.mockImplementation(async () => JSON.stringify(def));
}

function createEsSearchResponse(hits, totalValue, took = 10) {
  return {
    took,
    hits: {
      total: { value: totalValue, relation: 'eq' },
      hits: hits.map((h, i) => ({
        _id: h._id || `doc-${i}`,
        _score: h._score || 1.0,
        _source: h._source || {}
      }))
    }
  };
}

// ─── loadSearchToolDefinition ───────────────────────────────

describe('loadSearchToolDefinition', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
  });

  it('loads and parses a valid search tool definition', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    const result = await loadSearchToolDefinition('vigil-search-test');
    assert.equal(result.name, 'test-keyword-tool');
    assert.equal(result.retrieval_strategy, 'keyword');
  });

  it('throws "Search tool definition not found" for ENOENT', async () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    mockReadFile.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(
      () => loadSearchToolDefinition('vigil-search-nonexistent'),
      { message: /Search tool definition not found/ }
    );
  });

  it('throws descriptive error for JSON parse failure', async () => {
    mockReadFile.mock.mockImplementation(async () => '{bad json');

    await assert.rejects(
      () => loadSearchToolDefinition('vigil-search-broken'),
      { message: /Failed to load search tool definition/ }
    );
  });
});

// ─── executeSearchTool: validation ──────────────────────────

describe('executeSearchTool validation', () => {
  it('rejects empty string query', async () => {
    await assert.rejects(
      () => executeSearchTool('any-tool', ''),
      { message: /query must be a non-empty string/ }
    );
  });

  it('rejects null query', async () => {
    await assert.rejects(
      () => executeSearchTool('any-tool', null),
      { message: /query must be a non-empty string/ }
    );
  });

  it('rejects undefined query', async () => {
    await assert.rejects(
      () => executeSearchTool('any-tool', undefined),
      { message: /query must be a non-empty string/ }
    );
  });

  it('rejects numeric query', async () => {
    await assert.rejects(
      () => executeSearchTool('any-tool', 42),
      { message: /query must be a non-empty string/ }
    );
  });
});

// ─── executeSearchTool: keyword strategy ────────────────────

describe('executeSearchTool keyword strategy', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
    mockClientSearch.mock.resetCalls();
    mockEmbedText.mock.resetCalls();
  });

  it('calls client.search with correct multi_match shape', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([
        { _id: 'asset-1', _score: 5.0, _source: { name: 'web-prod-01', criticality: 'tier-1', owner: 'platform' } }
      ], 1)
    );

    await executeSearchTool('vigil-search-test', 'web-prod-01');

    assert.equal(mockClientSearch.mock.callCount(), 1);
    const [args] = mockClientSearch.mock.calls[0].arguments;
    assert.equal(args.index, 'test-index');
    assert.equal(args.size, 10);
    // Should be a multi_match query (no filter in this definition)
    assert.ok(args.query.multi_match, 'expected multi_match query');
    assert.equal(args.query.multi_match.query, 'web-prod-01');
    assert.deepEqual(args.query.multi_match.fields, ['name', 'description']);
  });

  it('wraps query in bool when filter is present', async () => {
    const def = createKeywordDefinition({
      filter: { term: { status: 'active' } }
    });
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([], 0)
    );

    await executeSearchTool('vigil-search-test', 'query');

    const [args] = mockClientSearch.mock.calls[0].arguments;
    assert.ok(args.query.bool, 'expected bool query wrapper when filter present');
    assert.ok(args.query.bool.must, 'expected must clause');
    assert.ok(args.query.bool.filter, 'expected filter clause');
  });

  it('returns {results, total, took} shape', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([
        { _id: 'a1', _score: 3.0, _source: { name: 'web-prod', criticality: 'tier-1', owner: 'team-a' } },
        { _id: 'a2', _score: 1.5, _source: { name: 'db-staging', criticality: 'tier-2', owner: 'team-b' } }
      ], 2, 15)
    );

    const result = await executeSearchTool('vigil-search-test', 'web');

    assert.ok(Array.isArray(result.results));
    assert.equal(result.results.length, 2);
    assert.equal(typeof result.total, 'number');
    assert.equal(result.total, 2);
    assert.equal(typeof result.took, 'number');
  });

  it('filters result fields to only declared fields', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([
        { _id: 'a1', _score: 3.0, _source: {
          name: 'web-prod', criticality: 'tier-1', owner: 'team-a',
          internal_field: 'should-not-appear', secret: 'hidden'
        }}
      ], 1)
    );

    const result = await executeSearchTool('vigil-search-test', 'web');

    const first = result.results[0];
    assert.equal(first.name, 'web-prod');
    assert.equal(first.criticality, 'tier-1');
    assert.equal(first.owner, 'team-a');
    assert.equal(first._id, 'a1');
    assert.equal(first._score, 3.0);
    // Fields not in result_fields must NOT appear
    assert.equal(first.internal_field, undefined);
    assert.equal(first.secret, undefined);
  });

  it('handles hits.total as a number (ES7 format)', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () => ({
      took: 5,
      hits: {
        total: 42, // ES7 format: just a number
        hits: []
      }
    }));

    const result = await executeSearchTool('vigil-search-test', 'query');
    assert.equal(result.total, 42);
  });

  it('handles empty result set', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([], 0)
    );

    const result = await executeSearchTool('vigil-search-test', 'nothing');
    assert.equal(result.results.length, 0);
    assert.equal(result.total, 0);
  });

  it('does not call embedText for keyword strategy', async () => {
    const def = createKeywordDefinition();
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([], 0)
    );

    await executeSearchTool('vigil-search-test', 'query');

    assert.equal(mockEmbedText.mock.callCount(), 0,
      'keyword strategy should not call embedText');
  });

  it('respects max_results limit', async () => {
    const def = createKeywordDefinition({ max_results: 2 });
    setupMockDefinition(def);

    mockClientSearch.mock.mockImplementation(async () =>
      createEsSearchResponse([
        { _source: { name: 'a' } },
        { _source: { name: 'b' } },
        { _source: { name: 'c' } }  // should be trimmed
      ], 3)
    );

    const result = await executeSearchTool('vigil-search-test', 'query');
    assert.ok(result.results.length <= 2, `expected <=2 results, got ${result.results.length}`);
  });
});

// ─── executeSearchTool: hybrid strategy ─────────────────────

describe('executeSearchTool hybrid strategy', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
    mockClientSearch.mock.resetCalls();
    mockEmbedText.mock.resetCalls();
    mockHybridSearch.mock.resetCalls();
  });

  it('calls embedText and hybridSearch with correct args', async () => {
    const def = createHybridDefinition();
    setupMockDefinition(def);

    const fakeVector = [0.1, 0.2, 0.3];
    mockEmbedText.mock.mockImplementation(async () => fakeVector);
    mockHybridSearch.mock.mockImplementation(async () => ({
      results: [{ _id: 'r1', _score: 0.9, title: 'T1062', technique_id: 'T1062', description: 'Lateral Movement' }],
      total: 1
    }));

    const result = await executeSearchTool('vigil-search-test', 'lateral movement');

    assert.equal(mockEmbedText.mock.callCount(), 1);
    assert.equal(mockEmbedText.mock.calls[0].arguments[0], 'lateral movement');

    assert.equal(mockHybridSearch.mock.callCount(), 1);
    const [index, textFields, vectorField, query, queryVector, opts] =
      mockHybridSearch.mock.calls[0].arguments;
    assert.equal(index, 'test-vectors');
    assert.deepEqual(textFields, ['description']);
    assert.equal(vectorField, 'description_embedding');
    assert.equal(query, 'lateral movement');
    assert.deepEqual(queryVector, fakeVector);
    assert.equal(opts.k, 5);

    assert.ok(Array.isArray(result.results));
    assert.equal(result.results.length, 1);
  });

  it('filters result fields from hybrid search results', async () => {
    const def = createHybridDefinition();
    setupMockDefinition(def);

    mockEmbedText.mock.mockImplementation(async () => [0.1]);
    mockHybridSearch.mock.mockImplementation(async () => ({
      results: [{
        _id: 'r1', _score: 0.95,
        title: 'Attack Technique', technique_id: 'T1234', description: 'Desc',
        raw_embedding: [0.1, 0.2], // not in result_fields
        internal_notes: 'secret'    // not in result_fields
      }],
      total: 1
    }));

    const result = await executeSearchTool('vigil-search-test', 'attack');

    const first = result.results[0];
    assert.equal(first.title, 'Attack Technique');
    assert.equal(first.technique_id, 'T1234');
    assert.equal(first.description, 'Desc');
    assert.equal(first._id, 'r1');
    assert.equal(first.raw_embedding, undefined, 'raw_embedding should be filtered out');
    assert.equal(first.internal_notes, undefined, 'internal_notes should be filtered out');
  });

  it('does not call client.search for hybrid strategy', async () => {
    const def = createHybridDefinition();
    setupMockDefinition(def);

    mockEmbedText.mock.mockImplementation(async () => [0.1]);
    mockHybridSearch.mock.mockImplementation(async () => ({
      results: [], total: 0
    }));

    await executeSearchTool('vigil-search-test', 'query');

    assert.equal(mockClientSearch.mock.callCount(), 0,
      'hybrid strategy should not call client.search directly');
  });
});

// ─── executeSearchTool: knn strategy ────────────────────────

describe('executeSearchTool knn strategy', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
    mockEmbedText.mock.resetCalls();
    mockKnnSearch.mock.resetCalls();
    mockClientSearch.mock.resetCalls();
  });

  it('calls embedText and knnSearch with correct args', async () => {
    const def = createKnnDefinition();
    setupMockDefinition(def);

    const fakeVector = [0.5, 0.6, 0.7];
    mockEmbedText.mock.mockImplementation(async () => fakeVector);
    mockKnnSearch.mock.mockImplementation(async () => ({
      results: [{ _id: 'e1', _score: 0.85, title: 'Result', content: 'Body' }],
      total: 1
    }));

    const result = await executeSearchTool('vigil-search-test', 'similar content');

    assert.equal(mockEmbedText.mock.callCount(), 1);
    assert.equal(mockKnnSearch.mock.callCount(), 1);

    const [index, vectorField, queryVector, opts] =
      mockKnnSearch.mock.calls[0].arguments;
    assert.equal(index, 'test-embeddings');
    assert.equal(vectorField, 'embedding');
    assert.deepEqual(queryVector, fakeVector);
    assert.equal(opts.k, 5);
    assert.equal(opts.minScore, 0.7);

    assert.ok(Array.isArray(result.results));
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].title, 'Result');
  });

  it('does not call client.search for knn strategy', async () => {
    const def = createKnnDefinition();
    setupMockDefinition(def);

    mockEmbedText.mock.mockImplementation(async () => [0.1]);
    mockKnnSearch.mock.mockImplementation(async () => ({
      results: [], total: 0
    }));

    await executeSearchTool('vigil-search-test', 'query');

    assert.equal(mockClientSearch.mock.callCount(), 0,
      'knn strategy should not call client.search directly');
  });

  it('filters result fields from knn results', async () => {
    const def = createKnnDefinition();
    setupMockDefinition(def);

    mockEmbedText.mock.mockImplementation(async () => [0.1]);
    mockKnnSearch.mock.mockImplementation(async () => ({
      results: [{
        _id: 'e1', _score: 0.9,
        title: 'Title', content: 'Content',
        embedding: [0.1, 0.2]  // not in result_fields
      }],
      total: 1
    }));

    const result = await executeSearchTool('vigil-search-test', 'query');

    const first = result.results[0];
    assert.equal(first.title, 'Title');
    assert.equal(first.content, 'Content');
    assert.equal(first.embedding, undefined, 'embedding vector should be filtered out');
  });
});

// ─── executeSearchTool: unknown strategy ────────────────────

describe('executeSearchTool unknown strategy', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
  });

  it('throws for unknown retrieval_strategy', async () => {
    const def = createKeywordDefinition({
      name: 'bad-strategy-tool',
      retrieval_strategy: 'telepathy'
    });
    setupMockDefinition(def);

    await assert.rejects(
      () => executeSearchTool('vigil-search-bad', 'query'),
      { message: /Unknown retrieval_strategy 'telepathy'.*bad-strategy-tool/ }
    );
  });
});
