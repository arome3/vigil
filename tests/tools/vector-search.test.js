import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { embedText, embedBatch } from '../../src/embeddings/embedding-service.js';
import { knnSearch, hybridSearch } from '../../src/search/hybrid-search.js';
import client from '../../src/utils/elastic-client.js';

const TEST_INDEX = 'vigil-runbooks';
const TEST_DOC_ID = 'test-vector-search-001';

// ── Embedding Service ──────────────────────────────────────

describe('Embedding Service', () => {
  it('embedText returns a 1024-dim float array', async () => {
    const vector = await embedText('Restart the Kubernetes pod to resolve OOM errors');
    assert.ok(Array.isArray(vector), 'result should be an array');
    assert.equal(vector.length, 1024, 'vector should have 1024 dimensions');
    assert.equal(typeof vector[0], 'number', 'elements should be numbers');
    assert.ok(Number.isFinite(vector[0]), 'elements should be finite floats');
  });

  it('embedBatch returns one 1024-dim vector per input text', async () => {
    const texts = [
      'Scale deployment replicas to handle traffic spike',
      'Rotate compromised API keys across all services'
    ];
    const vectors = await embedBatch(texts);
    assert.equal(vectors.length, texts.length, 'should return one vector per input');
    for (const vec of vectors) {
      assert.equal(vec.length, 1024, 'each vector should have 1024 dims');
    }
  });

  it('rejects empty input', async () => {
    await assert.rejects(() => embedText(''), /non-empty string/);
    await assert.rejects(() => embedText(null), /non-empty string/);
  });

  it('rejects invalid batch input', async () => {
    await assert.rejects(() => embedBatch([]), /non-empty array/);
    await assert.rejects(() => embedBatch('not an array'), /non-empty array/);
  });
});

// ── kNN Search ──────────────────────────────────────────────

describe('kNN Search', () => {
  let testVector;

  before(async () => {
    // Generate a real embedding for the test document
    testVector = await embedText(
      'Runbook for resolving out-of-memory errors in Kubernetes pods. '
      + 'Steps: check resource limits, inspect pod logs, restart pod, '
      + 'scale horizontally if recurring.'
    );

    // Index the test document with the real vector
    await client.index({
      index: TEST_INDEX,
      id: TEST_DOC_ID,
      document: {
        runbook_id: TEST_DOC_ID,
        title: 'K8s OOM Resolution',
        description: 'Steps to resolve out-of-memory errors in Kubernetes',
        content: 'Runbook for resolving out-of-memory errors in Kubernetes pods. '
          + 'Steps: check resource limits, inspect pod logs, restart pod, '
          + 'scale horizontally if recurring.',
        content_vector: testVector,
        incident_types: ['infrastructure'],
        applicable_services: ['k8s-cluster'],
        severity_levels: ['high'],
        tags: ['kubernetes', 'oom', 'memory']
      },
      refresh: true
    });
  });

  after(async () => {
    try {
      await client.delete({ index: TEST_INDEX, id: TEST_DOC_ID, refresh: true });
    } catch {
      // Ignore if already deleted
    }
  });

  it('knnSearch returns results with _score > 0', async () => {
    const queryVector = await embedText('How to fix Kubernetes out of memory');
    const result = await knnSearch(TEST_INDEX, 'content_vector', queryVector, { k: 3 });

    assert.ok(result.results.length > 0, 'should return at least one result');
    assert.ok(result.results[0]._score > 0, 'top result should have positive score');
  });

  it('results exclude content_vector field', async () => {
    const queryVector = await embedText('Kubernetes pod restart');
    const result = await knnSearch(TEST_INDEX, 'content_vector', queryVector, { k: 3 });

    for (const doc of result.results) {
      assert.equal(doc.content_vector, undefined, 'content_vector should be stripped');
    }
  });

  it('semantically similar query retrieves the test doc', async () => {
    const queryVector = await embedText('memory issues in K8s containers');
    const result = await knnSearch(TEST_INDEX, 'content_vector', queryVector, { k: 5 });

    const found = result.results.find((r) => r._id === TEST_DOC_ID);
    assert.ok(found, 'test document should appear in semantic search results');
  });
});

// ── Hybrid Search ───────────────────────────────────────────

describe('Hybrid Search', () => {
  let testVector;

  before(async () => {
    testVector = await embedText(
      'Runbook for rotating compromised API keys. '
      + 'Steps: identify affected services, generate new keys, update secrets, '
      + 'verify connectivity, revoke old keys.'
    );

    await client.index({
      index: TEST_INDEX,
      id: 'test-vector-search-002',
      document: {
        runbook_id: 'test-vector-search-002',
        title: 'API Key Rotation',
        description: 'Emergency procedure for compromised API key rotation',
        content: 'Runbook for rotating compromised API keys. '
          + 'Steps: identify affected services, generate new keys, update secrets, '
          + 'verify connectivity, revoke old keys.',
        content_vector: testVector,
        incident_types: ['security'],
        applicable_services: ['api-gateway'],
        severity_levels: ['critical'],
        tags: ['security', 'api-keys', 'rotation']
      },
      refresh: true
    });
  });

  after(async () => {
    try {
      await client.delete({ index: TEST_INDEX, id: 'test-vector-search-002', refresh: true });
    } catch {
      // Ignore if already deleted
    }
  });

  it('hybridSearch returns ranked results', async () => {
    const queryVector = await embedText('compromised API keys rotation procedure');
    const result = await hybridSearch(
      TEST_INDEX,
      ['title', 'description', 'content'],
      'content_vector',
      'API key rotation',
      queryVector,
      { size: 5 }
    );

    assert.ok(result.results.length > 0, 'should return at least one result');
    assert.ok(typeof result.total === 'number', 'total should be a number');
  });

  it('hybrid results exclude vector fields', async () => {
    const queryVector = await embedText('security key rotation');
    const result = await hybridSearch(
      TEST_INDEX,
      ['title', 'content'],
      'content_vector',
      'security rotation',
      queryVector,
      { size: 5 }
    );

    for (const doc of result.results) {
      assert.equal(doc.content_vector, undefined, 'content_vector should be stripped');
      assert.equal(doc.description_vector, undefined, 'description_vector should be stripped');
    }
  });
});
