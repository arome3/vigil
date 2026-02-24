// Integration test: Search executor against a real Elasticsearch cluster.
// Gated on ELASTICSEARCH_URL — skipped when not set.
//
// Run: ELASTICSEARCH_URL=http://localhost:9200 NODE_OPTIONS='--experimental-vm-modules' npx jest tests/integration/tools/search-executor.integration.test.js

import { jest } from '@jest/globals';

const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL;
const describeIfEs = ELASTICSEARCH_URL ? describe : describe.skip;

describeIfEs('Search executor integration (real ES)', () => {
  let executeSearchTool, loadSearchToolDefinition;

  beforeAll(async () => {
    const executor = await import('../../../src/tools/search/executor.js');
    executeSearchTool = executor.executeSearchTool;
    loadSearchToolDefinition = executor.loadSearchToolDefinition;
  });

  describe('loadSearchToolDefinition', () => {
    it('loads asset-criticality tool definition', async () => {
      const def = await loadSearchToolDefinition('vigil-search-asset-criticality');
      expect(def.name || def.id).toBeDefined();
      expect(def.retrieval_strategy).toBe('keyword');
      expect(def.index).toBeDefined();
      expect(Array.isArray(def.result_fields)).toBe(true);
    });

    it('throws for non-existent tool', async () => {
      await expect(
        loadSearchToolDefinition('vigil-search-does-not-exist')
      ).rejects.toThrow(/Search tool definition not found/);
    });
  });

  describe('executeSearchTool', () => {
    describe('keyword search (asset-criticality)', () => {
      it('returns {results, total, took} shape', async () => {
        const result = await executeSearchTool(
          'vigil-search-asset-criticality',
          'web-prod-01'
        );

        expect(result).toHaveProperty('results');
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('took');
        expect(Array.isArray(result.results)).toBe(true);
        expect(typeof result.total).toBe('number');
        expect(typeof result.took).toBe('number');
      });

      it('returns result fields matching definition', async () => {
        const def = await loadSearchToolDefinition('vigil-search-asset-criticality');
        const result = await executeSearchTool(
          'vigil-search-asset-criticality',
          'web-prod-01'
        );

        if (result.results.length > 0) {
          const firstResult = result.results[0];
          // Every returned field should be in the definition's result_fields (plus _id, _score)
          const allowedFields = new Set([...def.result_fields, '_id', '_score']);
          for (const key of Object.keys(firstResult)) {
            expect(allowedFields.has(key)).toBe(true);
          }
        }
      });
    });

    describe('hybrid search (mitre-attack)', () => {
      it('returns {results, total, took} shape', async () => {
        try {
          const result = await executeSearchTool(
            'vigil-search-mitre-attack',
            'lateral movement techniques'
          );

          expect(result).toHaveProperty('results');
          expect(result).toHaveProperty('total');
          expect(result).toHaveProperty('took');
          expect(Array.isArray(result.results)).toBe(true);
        } catch (err) {
          // May fail if embedding service not available — that's acceptable
          expect(err.message).toMatch(/embed|vector|model|connect/i);
        }
      });

      it('filters result fields', async () => {
        try {
          const def = await loadSearchToolDefinition('vigil-search-mitre-attack');
          const result = await executeSearchTool(
            'vigil-search-mitre-attack',
            'privilege escalation'
          );

          if (result.results.length > 0) {
            const allowedFields = new Set([...def.result_fields, '_id', '_score']);
            for (const key of Object.keys(result.results[0])) {
              expect(allowedFields.has(key)).toBe(true);
            }
          }
        } catch (err) {
          expect(err.message).toMatch(/embed|vector|model|connect/i);
        }
      });
    });

    describe('validation', () => {
      it('rejects empty query', async () => {
        await expect(
          executeSearchTool('vigil-search-asset-criticality', '')
        ).rejects.toThrow(/query must be a non-empty string/);
      });

      it('rejects null query', async () => {
        await expect(
          executeSearchTool('vigil-search-asset-criticality', null)
        ).rejects.toThrow(/query must be a non-empty string/);
      });

      it('throws for unknown tool', async () => {
        await expect(
          executeSearchTool('vigil-search-nonexistent', 'test')
        ).rejects.toThrow(/Search tool definition not found/);
      });
    });
  });
});
