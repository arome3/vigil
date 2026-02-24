// Integration test: ES|QL executor against a real Elasticsearch cluster.
// Gated on ELASTICSEARCH_URL — skipped when not set.
//
// Run: ELASTICSEARCH_URL=http://localhost:9200 NODE_OPTIONS='--experimental-vm-modules' npx jest tests/integration/tools/esql-executor.integration.test.js

import { jest } from '@jest/globals';

const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL;
const describeIfEs = ELASTICSEARCH_URL ? describe : describe.skip;

describeIfEs('ES|QL executor integration (real ES)', () => {
  let executeEsqlTool, loadToolDefinition, validateParams;

  beforeAll(async () => {
    // Import the real modules — no mocking
    const executor = await import('../../../src/tools/esql/executor.js');
    executeEsqlTool = executor.executeEsqlTool;
    loadToolDefinition = executor.loadToolDefinition;
    validateParams = executor.validateParams;
  });

  describe('loadToolDefinition', () => {
    it('loads a real tool definition', async () => {
      const def = await loadToolDefinition('vigil-esql-alert-enrichment');
      expect(def.id).toBe('vigil-esql-alert-enrichment');
      expect(def.type).toBe('esql');
      expect(def.configuration.query).toBeDefined();
      expect(def.configuration.params).toBeDefined();
    });

    it('throws for non-existent tool', async () => {
      await expect(
        loadToolDefinition('vigil-esql-does-not-exist')
      ).rejects.toThrow(/Tool definition not found/);
    });
  });

  describe('executeEsqlTool', () => {
    it('returns {columns, values, took} shape for alert-enrichment', async () => {
      // This query runs against real indices — may return 0 rows if no data exists,
      // but the shape should still be correct
      const result = await executeEsqlTool('vigil-esql-alert-enrichment', {
        source_ip: '10.0.0.1',
        username: 'test-user'
      }, { timeout: 10000 });

      expect(result).toHaveProperty('columns');
      expect(result).toHaveProperty('values');
      expect(result).toHaveProperty('took');
      expect(Array.isArray(result.columns)).toBe(true);
      expect(Array.isArray(result.values)).toBe(true);
      expect(typeof result.took).toBe('number');
    });

    it('returns correct column names for alert-enrichment', async () => {
      const result = await executeEsqlTool('vigil-esql-alert-enrichment', {
        source_ip: '10.0.0.1',
        username: 'test-user'
      }, { timeout: 10000 });

      if (result.columns.length > 0) {
        const colNames = result.columns.map(c => c.name);
        // These are the expected output columns from the alert-enrichment query
        for (const expected of ['event_count', 'unique_destinations', 'failed_auths', 'risk_signal']) {
          expect(colNames).toContain(expected);
        }
      }
    });

    it('handles change-correlation tool (may trigger fallback)', async () => {
      // This tool uses LOOKUP JOIN which may not be available
      // Either it succeeds or throws a descriptive error
      try {
        const result = await executeEsqlTool('vigil-esql-change-correlation', {
          max_gap_seconds: 300
        }, { timeout: 10000 });

        expect(result).toHaveProperty('columns');
        expect(result).toHaveProperty('values');
      } catch (err) {
        // Acceptable: fallback module not found, or LOOKUP JOIN not supported
        expect(err.message).toMatch(
          /ES\|QL query failed|change-correlation-fallback|LOOKUP/i
        );
      }
    });

    it('validates params before executing query', async () => {
      await expect(
        executeEsqlTool('vigil-esql-alert-enrichment', {
          // Missing required source_ip
          username: 'test-user'
        })
      ).rejects.toThrow(/Missing required parameter/);
    });
  });
});
