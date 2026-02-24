import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '../../../../src/tools/esql');

// ─── Mock setup ─────────────────────────────────────────────

const mockReadFile = mock.fn();
const mockTransportRequest = mock.fn();

mock.module(import.meta.resolve('../../../../src/utils/elastic-client.js'), {
  defaultExport: {
    transport: { request: mockTransportRequest }
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

// We mock node:fs/promises for loadToolDefinition isolation tests,
// but also test validateParams with real tool definitions (no mock needed).
// For the executor pipeline tests, we mock fs to control the tool definition.
mock.module('node:fs/promises', {
  namedExports: {
    readFile: mockReadFile
  }
});

// ─── Import module under test (after mocks) ─────────────────

const { loadToolDefinition, validateParams, executeEsqlTool } =
  await import('../../../../src/tools/esql/executor.js');

// ─── Helpers ────────────────────────────────────────────────

function createMockDefinition(overrides = {}) {
  return {
    id: 'vigil-esql-test-tool',
    type: 'esql',
    description: 'A test tool',
    tags: ['vigil', 'test'],
    agent: 'vigil-triage',
    configuration: {
      query: 'FROM logs-* | WHERE source.ip == ?source_ip | LIMIT 10',
      params: {
        source_ip: {
          type: 'keyword',
          required: true,
          description: 'Source IP'
        }
      }
    },
    ...overrides
  };
}

function setupMockDefinition(def) {
  mockReadFile.mock.mockImplementation(async () => JSON.stringify(def));
}

// ─── loadToolDefinition ─────────────────────────────────────

describe('loadToolDefinition', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
    mockReadFile.mock.mockImplementation(async () => '{}');
  });

  it('loads and parses a valid tool definition', async () => {
    const def = createMockDefinition();
    mockReadFile.mock.mockImplementation(async () => JSON.stringify(def));

    const result = await loadToolDefinition('vigil-esql-test-tool');
    assert.equal(result.id, 'vigil-esql-test-tool');
    assert.equal(result.type, 'esql');
  });

  it('throws "Tool definition not found" for ENOENT', async () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    mockReadFile.mock.mockImplementation(async () => { throw err; });

    await assert.rejects(
      () => loadToolDefinition('vigil-esql-nonexistent'),
      { message: /Tool definition not found/ }
    );
  });

  it('throws descriptive error for JSON parse failure', async () => {
    mockReadFile.mock.mockImplementation(async () => 'not-json{{{');

    await assert.rejects(
      () => loadToolDefinition('vigil-esql-broken'),
      { message: /Failed to load tool definition/ }
    );
  });
});

// ─── validateParams ─────────────────────────────────────────

describe('validateParams', () => {
  it('throws for missing required parameter', () => {
    const def = createMockDefinition();
    assert.throws(
      () => validateParams(def, {}),
      { message: /Missing required parameter 'source_ip'/ }
    );
  });

  it('applies default value for optional param', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          max_gap: { type: 'integer', required: false, default: 600, description: 'Gap' }
        }
      }
    });

    const result = validateParams(def, {});
    assert.equal(result.max_gap, 600);
  });

  it('skips optional param without default', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          optional_field: { type: 'keyword', required: false, description: 'Optional' }
        }
      }
    });

    const result = validateParams(def, {});
    assert.ok(!('optional_field' in result));
  });

  // Keyword coercion
  it('coerces keyword to string', () => {
    const def = createMockDefinition();
    const result = validateParams(def, { source_ip: 123 });
    assert.equal(result.source_ip, '123');
  });

  it('passes arrays through for keyword type (IN clauses)', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          ips: { type: 'keyword', required: true, description: 'IPs' }
        }
      }
    });

    const result = validateParams(def, { ips: ['1.1.1.1', '2.2.2.2'] });
    assert.deepEqual(result.ips, ['1.1.1.1', '2.2.2.2']);
  });

  // Integer coercion
  it('coerces valid integer', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          count: { type: 'integer', required: true, description: 'Count' }
        }
      }
    });

    const result = validateParams(def, { count: '42' });
    assert.equal(result.count, 42);
  });

  it('rejects non-integer for integer type', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          count: { type: 'integer', required: true, description: 'Count' }
        }
      }
    });

    assert.throws(
      () => validateParams(def, { count: '3.14' }),
      { message: /must be an integer/ }
    );
  });

  it('rejects non-numeric string for integer type', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          count: { type: 'integer', required: true, description: 'Count' }
        }
      }
    });

    assert.throws(
      () => validateParams(def, { count: 'abc' }),
      { message: /must be an integer/ }
    );
  });

  // Double coercion
  it('coerces valid double', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          threshold: { type: 'double', required: true, description: 'Threshold' }
        }
      }
    });

    const result = validateParams(def, { threshold: '3.14' });
    assert.equal(result.threshold, 3.14);
  });

  it('rejects NaN for double type', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          threshold: { type: 'double', required: true, description: 'Threshold' }
        }
      }
    });

    assert.throws(
      () => validateParams(def, { threshold: 'not-a-number' }),
      { message: /must be a number/ }
    );
  });

  // Date coercion
  it('accepts ISO 8601 date string', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          start: { type: 'date', required: true, description: 'Start' }
        }
      }
    });

    const result = validateParams(def, { start: '2026-02-24T10:00:00.000Z' });
    assert.equal(result.start, '2026-02-24T10:00:00.000Z');
  });

  it('converts Date object to ISO string', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          start: { type: 'date', required: true, description: 'Start' }
        }
      }
    });

    const date = new Date('2026-01-01T00:00:00.000Z');
    const result = validateParams(def, { start: date });
    assert.equal(result.start, '2026-01-01T00:00:00.000Z');
  });

  it('passes through value for unknown param types', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          custom: { type: 'custom_type', required: true, description: 'Custom' }
        }
      }
    });

    const result = validateParams(def, { custom: { complex: 'value' } });
    assert.deepEqual(result.custom, { complex: 'value' });
  });

  it('treats null as missing for required param', () => {
    const def = createMockDefinition();
    assert.throws(
      () => validateParams(def, { source_ip: null }),
      { message: /Missing required parameter 'source_ip'/ }
    );
  });

  it('rejects invalid date string', () => {
    const def = createMockDefinition({
      configuration: {
        query: 'SELECT 1',
        params: {
          start: { type: 'date', required: true, description: 'Start' }
        }
      }
    });

    assert.throws(
      () => validateParams(def, { start: 'not-a-date' }),
      { message: /must be a valid date/ }
    );
  });
});

// ─── executeEsqlTool ────────────────────────────────────────

describe('executeEsqlTool', () => {
  beforeEach(() => {
    mockReadFile.mock.resetCalls();
    mockTransportRequest.mock.resetCalls();
  });

  it('sends correct transport.request shape', async () => {
    const def = createMockDefinition();
    setupMockDefinition(def);

    mockTransportRequest.mock.mockImplementation(async () => ({
      body: {
        columns: [{ name: 'source.ip', type: 'keyword' }],
        values: [['10.0.0.1']],
        took: 15
      }
    }));

    await executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' });

    assert.equal(mockTransportRequest.mock.callCount(), 1);
    const [reqArgs] = mockTransportRequest.mock.calls[0].arguments;
    assert.equal(reqArgs.method, 'POST');
    assert.equal(reqArgs.path, '/_query');
    assert.equal(reqArgs.body.query, def.configuration.query);
    assert.ok(Array.isArray(reqArgs.body.params));
    assert.deepEqual(reqArgs.body.params[0], { source_ip: '10.0.0.1' });
  });

  it('omits params array when no params needed', async () => {
    const def = createMockDefinition({
      configuration: {
        query: 'FROM logs-* | LIMIT 1',
        params: {}
      }
    });
    setupMockDefinition(def);

    mockTransportRequest.mock.mockImplementation(async () => ({
      body: { columns: [], values: [], took: 5 }
    }));

    await executeEsqlTool('vigil-esql-test-tool', {});

    const [reqArgs] = mockTransportRequest.mock.calls[0].arguments;
    assert.ok(!('params' in reqArgs.body), 'params should be omitted when empty');
  });

  it('returns {columns, values, took} shape', async () => {
    const def = createMockDefinition();
    setupMockDefinition(def);

    mockTransportRequest.mock.mockImplementation(async () => ({
      body: {
        columns: [{ name: 'risk_signal', type: 'double' }],
        values: [[42.5]],
        took: 20
      }
    }));

    const result = await executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' });

    assert.ok(Array.isArray(result.columns));
    assert.ok(Array.isArray(result.values));
    assert.equal(typeof result.took, 'number');
    assert.deepEqual(result.columns, [{ name: 'risk_signal', type: 'double' }]);
    assert.deepEqual(result.values, [[42.5]]);
    assert.equal(result.took, 20);
  });

  it('passes timeout from options', async () => {
    const def = createMockDefinition();
    setupMockDefinition(def);

    mockTransportRequest.mock.mockImplementation(async () => ({
      body: { columns: [], values: [], took: 0 }
    }));

    await executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }, { timeout: 5000 });

    const [, opts] = mockTransportRequest.mock.calls[0].arguments;
    assert.equal(opts.requestTimeout, 5000);
  });

  it('uses default timeout when not specified', async () => {
    const def = createMockDefinition();
    setupMockDefinition(def);

    mockTransportRequest.mock.mockImplementation(async () => ({
      body: { columns: [], values: [], took: 0 }
    }));

    await executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' });

    const [, opts] = mockTransportRequest.mock.calls[0].arguments;
    assert.equal(opts.requestTimeout, 30000);
  });

  it('triggers LOOKUP JOIN fallback on tech-preview error', async () => {
    const def = createMockDefinition({
      lookupJoinTechPreview: true,
      configuration: {
        query: 'FROM logs | LOOKUP JOIN index ON field',
        params: {
          source_ip: { type: 'keyword', required: true, description: 'IP' }
        }
      }
    });
    setupMockDefinition(def);

    const lookupErr = new Error('unknown command [lookup]');
    lookupErr.meta = { statusCode: 400, body: { error: { reason: 'unknown command [lookup]' } } };
    mockTransportRequest.mock.mockImplementation(async () => { throw lookupErr; });

    // The fallback dynamic import will fail (module doesn't exist in test env).
    // The key proof that the fallback path was entered is that the error is NOT
    // the standard "ES|QL query failed" rethrow — it's a module import error.
    await assert.rejects(
      () => executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }),
      (err) => {
        // Must NOT be the standard non-fallback error path
        assert.ok(
          !err.message.startsWith('ES|QL query failed'),
          `Expected fallback path, but got standard error rethrow: ${err.message}`
        );
        return true;
      }
    );
  });

  it('triggers LOOKUP JOIN fallback for "lookup_join" error variant', async () => {
    const def = createMockDefinition({
      lookupJoinTechPreview: true,
      configuration: {
        query: 'FROM logs | LOOKUP JOIN index ON field',
        params: {
          source_ip: { type: 'keyword', required: true, description: 'IP' }
        }
      }
    });
    setupMockDefinition(def);

    const lookupErr = new Error('lookup_join is not supported');
    lookupErr.meta = { statusCode: 400, body: { error: { reason: 'lookup_join is not supported' } } };
    mockTransportRequest.mock.mockImplementation(async () => { throw lookupErr; });

    await assert.rejects(
      () => executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }),
      (err) => {
        assert.ok(
          !err.message.startsWith('ES|QL query failed'),
          `Expected fallback path for lookup_join variant, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('triggers LOOKUP JOIN fallback for "parsing_exception" error variant', async () => {
    const def = createMockDefinition({
      lookupJoinTechPreview: true,
      configuration: {
        query: 'FROM logs | LOOKUP JOIN index ON field',
        params: {
          source_ip: { type: 'keyword', required: true, description: 'IP' }
        }
      }
    });
    setupMockDefinition(def);

    const lookupErr = new Error('parsing_exception');
    lookupErr.meta = { statusCode: 400, body: { error: { reason: 'parsing_exception' } } };
    mockTransportRequest.mock.mockImplementation(async () => { throw lookupErr; });

    await assert.rejects(
      () => executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }),
      (err) => {
        assert.ok(
          !err.message.startsWith('ES|QL query failed'),
          `Expected fallback path for parsing_exception variant, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('skips fallback when lookupJoinTechPreview is not set', async () => {
    const def = createMockDefinition({
      // no lookupJoinTechPreview field
      configuration: {
        query: 'FROM logs | WHERE x = ?source_ip',
        params: {
          source_ip: { type: 'keyword', required: true, description: 'IP' }
        }
      }
    });
    setupMockDefinition(def);

    const lookupErr = new Error('unknown command [lookup]');
    lookupErr.meta = { statusCode: 400, body: { error: { reason: 'unknown command [lookup]' } } };
    mockTransportRequest.mock.mockImplementation(async () => { throw lookupErr; });

    // Without lookupJoinTechPreview, should go through standard error path
    await assert.rejects(
      () => executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }),
      { message: /ES\|QL query failed.*status 400/ }
    );
  });

  it('does not trigger fallback for non-LOOKUP errors', async () => {
    const def = createMockDefinition({
      lookupJoinTechPreview: true,
      configuration: {
        query: 'FROM logs | LOOKUP JOIN index ON field',
        params: {
          source_ip: { type: 'keyword', required: true, description: 'IP' }
        }
      }
    });
    setupMockDefinition(def);

    const otherErr = new Error('index_not_found_exception');
    otherErr.meta = { statusCode: 404, body: { error: { reason: 'index_not_found_exception' } } };
    mockTransportRequest.mock.mockImplementation(async () => { throw otherErr; });

    await assert.rejects(
      () => executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }),
      { message: /ES\|QL query failed.*status 404.*index_not_found_exception/ }
    );
  });

  it('passes meta: true option to transport.request', async () => {
    const def = createMockDefinition();
    setupMockDefinition(def);

    mockTransportRequest.mock.mockImplementation(async () => ({
      body: { columns: [], values: [], took: 0 }
    }));

    await executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' });

    const [, opts] = mockTransportRequest.mock.calls[0].arguments;
    assert.equal(opts.meta, true, 'meta option must be true for response.body access');
  });

  it('wraps errors with context (status code and reason)', async () => {
    const def = createMockDefinition();
    setupMockDefinition(def);

    const esErr = new Error('timeout');
    esErr.meta = { statusCode: 408, body: { error: { reason: 'timeout' } } };
    mockTransportRequest.mock.mockImplementation(async () => { throw esErr; });

    await assert.rejects(
      () => executeEsqlTool('vigil-esql-test-tool', { source_ip: '10.0.0.1' }),
      (err) => {
        assert.ok(err.message.includes('408'));
        assert.ok(err.message.includes('timeout'));
        assert.ok(err.message.includes('vigil-esql-test-tool'));
        return true;
      }
    );
  });
});

// ─── Per-tool param validation (using real JSON files) ──────

describe('validateParams with real tool definitions', () => {
  function loadRealTool(name) {
    return JSON.parse(readFileSync(join(TOOLS_DIR, `${name}.json`), 'utf-8'));
  }

  it('alert-enrichment: accepts valid params', () => {
    const def = loadRealTool('vigil-esql-alert-enrichment');
    const result = validateParams(def, { source_ip: '10.0.0.1', username: 'alice' });
    assert.equal(result.source_ip, '10.0.0.1');
    assert.equal(result.username, 'alice');
  });

  it('alert-enrichment: rejects missing source_ip', () => {
    const def = loadRealTool('vigil-esql-alert-enrichment');
    assert.throws(
      () => validateParams(def, { username: 'alice' }),
      { message: /Missing required parameter 'source_ip'/ }
    );
  });

  it('historical-fp-rate: accepts valid rule_id', () => {
    const def = loadRealTool('vigil-esql-historical-fp-rate');
    const result = validateParams(def, { rule_id: 'rule-123' });
    assert.equal(result.rule_id, 'rule-123');
  });

  it('historical-fp-rate: rejects missing rule_id', () => {
    const def = loadRealTool('vigil-esql-historical-fp-rate');
    assert.throws(
      () => validateParams(def, {}),
      { message: /Missing required parameter 'rule_id'/ }
    );
  });

  it('attack-chain-tracer: accepts required + optional params', () => {
    const def = loadRealTool('vigil-esql-attack-chain-tracer');
    const result = validateParams(def, {
      window_start: '2026-02-24T00:00:00Z',
      window_end: '2026-02-24T06:00:00Z',
      initial_indicator: 'proc-12345',
      indicator_ip: '10.0.0.5'
    });
    assert.equal(result.window_start, '2026-02-24T00:00:00Z');
    assert.equal(result.window_end, '2026-02-24T06:00:00Z');
    assert.equal(result.initial_indicator, 'proc-12345');
    assert.equal(result.indicator_ip, '10.0.0.5');
    assert.ok(!('indicator_hash' in result)); // not provided, no default
  });

  it('blast-radius: accepts array for compromised_ips', () => {
    const def = loadRealTool('vigil-esql-blast-radius');
    const result = validateParams(def, { compromised_ips: ['10.0.0.1', '10.0.0.2'] });
    assert.deepEqual(result.compromised_ips, ['10.0.0.1', '10.0.0.2']);
  });

  it('change-correlation: applies default max_gap_seconds=600', () => {
    const def = loadRealTool('vigil-esql-change-correlation');
    const result = validateParams(def, {});
    assert.equal(result.max_gap_seconds, 600);
  });

  it('change-correlation: accepts custom max_gap_seconds', () => {
    const def = loadRealTool('vigil-esql-change-correlation');
    const result = validateParams(def, { max_gap_seconds: 300 });
    assert.equal(result.max_gap_seconds, 300);
  });

  it('ioc-sweep: accepts all 4 required keyword arrays', () => {
    const def = loadRealTool('vigil-esql-ioc-sweep');
    const result = validateParams(def, {
      malicious_ips: ['1.2.3.4'],
      malicious_domains: ['evil.com'],
      malicious_hashes: ['abc123'],
      malicious_processes: ['malware.exe']
    });
    assert.deepEqual(result.malicious_ips, ['1.2.3.4']);
    assert.deepEqual(result.malicious_domains, ['evil.com']);
  });

  it('behavioral-anomaly: applies default anomaly_threshold=8.0', () => {
    const def = loadRealTool('vigil-esql-behavioral-anomaly');
    const result = validateParams(def, { known_compromised_user: 'alice' });
    assert.equal(result.anomaly_threshold, 8.0);
    assert.equal(result.known_compromised_user, 'alice');
  });

  it('health-monitor: accepts all 5 required params', () => {
    const def = loadRealTool('vigil-esql-health-monitor');
    const result = validateParams(def, {
      service_name: 'api-gateway',
      baseline_avg: 150000.5,
      baseline_stddev: 25000.0,
      baseline_error_rate: 2.5,
      baseline_error_stddev: 0.8
    });
    assert.equal(result.service_name, 'api-gateway');
    assert.equal(result.baseline_avg, 150000.5);
  });

  it('dependency-tracer: accepts service_name', () => {
    const def = loadRealTool('vigil-esql-dependency-tracer');
    const result = validateParams(def, { service_name: 'payment-service' });
    assert.equal(result.service_name, 'payment-service');
  });

  it('recent-change-detector: accepts service_name', () => {
    const def = loadRealTool('vigil-esql-recent-change-detector');
    const result = validateParams(def, { service_name: 'user-service' });
    assert.equal(result.service_name, 'user-service');
  });

  it('impact-assessment: accepts target_service', () => {
    const def = loadRealTool('vigil-esql-impact-assessment');
    const result = validateParams(def, { target_service: 'notification-svc' });
    assert.equal(result.target_service, 'notification-svc');
  });

  it('health-comparison: accepts all 5 required params', () => {
    const def = loadRealTool('vigil-esql-health-comparison');
    const result = validateParams(def, {
      service_name: 'api-gateway',
      baseline_avg: 150000.5,
      baseline_stddev: 25000.0,
      max_error_rate: 5.0,
      min_throughput: 100.0
    });
    assert.equal(result.service_name, 'api-gateway');
    assert.equal(result.max_error_rate, 5.0);
    assert.equal(result.min_throughput, 100.0);
  });
});
