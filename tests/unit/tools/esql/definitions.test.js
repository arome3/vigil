import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '../../../../src/tools/esql');

// Discover all ES|QL tool definition files
const toolFiles = readdirSync(TOOLS_DIR)
  .filter(f => f.startsWith('vigil-esql-') && f.endsWith('.json'))
  .sort();

const VALID_PARAM_TYPES = new Set(['keyword', 'integer', 'double', 'date']);

const REQUIRED_FIELDS = ['id', 'type', 'description', 'tags', 'agent', 'configuration'];

describe('ES|QL tool definitions', () => {
  it('discovers at least 12 tool definition files', () => {
    assert.ok(
      toolFiles.length >= 12,
      `Expected >=12 tool definitions, found ${toolFiles.length}: ${toolFiles.join(', ')}`
    );
  });

  for (const file of toolFiles) {
    const filePath = join(TOOLS_DIR, file);
    const expectedId = basename(file, '.json');

    describe(file, () => {
      let definition;

      it('is valid JSON', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.ok(definition && typeof definition === 'object');
      });

      it('has all required top-level fields', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);

        for (const field of REQUIRED_FIELDS) {
          assert.ok(
            definition[field] !== undefined,
            `Missing required field '${field}' in ${file}`
          );
        }
      });

      it('has correct field types', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);

        assert.equal(typeof definition.id, 'string', 'id must be a string');
        assert.equal(typeof definition.type, 'string', 'type must be a string');
        assert.equal(typeof definition.description, 'string', 'description must be a string');
        assert.ok(Array.isArray(definition.tags), 'tags must be an array');
        assert.equal(typeof definition.agent, 'string', 'agent must be a string');
        assert.equal(typeof definition.configuration, 'object', 'configuration must be an object');
      });

      it('has type "esql"', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.equal(definition.type, 'esql');
      });

      it('has id matching filename', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.equal(definition.id, expectedId, `id '${definition.id}' does not match filename '${expectedId}'`);
      });

      it('has non-empty description', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.ok(definition.description.length > 10, 'description is too short');
      });

      it('has tags array including "vigil"', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.ok(definition.tags.includes('vigil'), 'tags must include "vigil"');
      });

      it('has agent starting with "vigil-"', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.ok(definition.agent.startsWith('vigil-'), `agent '${definition.agent}' must start with "vigil-"`);
      });

      it('has configuration.query as non-empty string', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.equal(typeof definition.configuration.query, 'string');
        assert.ok(definition.configuration.query.length > 0, 'query must not be empty');
      });

      it('has configuration.params as an object', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        assert.equal(typeof definition.configuration.params, 'object');
        assert.ok(!Array.isArray(definition.configuration.params), 'params must not be an array');
      });

      it('has valid param types (keyword|integer|double|date)', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        const params = definition.configuration.params;

        for (const [paramName, schema] of Object.entries(params)) {
          assert.ok(
            VALID_PARAM_TYPES.has(schema.type),
            `param '${paramName}' has invalid type '${schema.type}' (expected one of: ${[...VALID_PARAM_TYPES].join(', ')})`
          );
        }
      });

      it('has required boolean on each param', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        const params = definition.configuration.params;

        for (const [paramName, schema] of Object.entries(params)) {
          assert.equal(
            typeof schema.required, 'boolean',
            `param '${paramName}' must have a boolean 'required' field`
          );
        }
      });

      it('has description on each param', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        const params = definition.configuration.params;

        for (const [paramName, schema] of Object.entries(params)) {
          assert.equal(
            typeof schema.description, 'string',
            `param '${paramName}' must have a string 'description' field`
          );
          assert.ok(
            schema.description.length > 0,
            `param '${paramName}' description must not be empty`
          );
        }
      });

      it('has query referencing all required params with ? prefix', () => {
        const raw = readFileSync(filePath, 'utf-8');
        definition = JSON.parse(raw);
        const params = definition.configuration.params;
        const query = definition.configuration.query;

        for (const [paramName, schema] of Object.entries(params)) {
          if (schema.required) {
            assert.ok(
              query.includes(`?${paramName}`),
              `query does not reference required param '?${paramName}'`
            );
          }
        }
      });
    });
  }
});

// ─── Per-tool specific param validations ────────────────────

describe('tool-specific param structures', () => {
  function loadTool(name) {
    return JSON.parse(readFileSync(join(TOOLS_DIR, `${name}.json`), 'utf-8'));
  }

  it('alert-enrichment requires source_ip and username', () => {
    const def = loadTool('vigil-esql-alert-enrichment');
    const params = def.configuration.params;
    assert.equal(params.source_ip.required, true);
    assert.equal(params.source_ip.type, 'keyword');
    assert.equal(params.username.required, true);
    assert.equal(params.username.type, 'keyword');
  });

  it('historical-fp-rate requires rule_id', () => {
    const def = loadTool('vigil-esql-historical-fp-rate');
    assert.equal(def.configuration.params.rule_id.required, true);
    assert.equal(def.configuration.params.rule_id.type, 'keyword');
  });

  it('attack-chain-tracer requires dates and initial_indicator, optionals for ip/hash', () => {
    const def = loadTool('vigil-esql-attack-chain-tracer');
    const p = def.configuration.params;
    assert.equal(p.window_start.required, true);
    assert.equal(p.window_start.type, 'date');
    assert.equal(p.window_end.required, true);
    assert.equal(p.window_end.type, 'date');
    assert.equal(p.initial_indicator.required, true);
    assert.equal(p.initial_indicator.type, 'keyword');
    assert.equal(p.indicator_ip.required, false);
    assert.equal(p.indicator_hash.required, false);
  });

  it('blast-radius requires compromised_ips keyword array', () => {
    const def = loadTool('vigil-esql-blast-radius');
    assert.equal(def.configuration.params.compromised_ips.required, true);
    assert.equal(def.configuration.params.compromised_ips.type, 'keyword');
  });

  it('change-correlation has optional max_gap_seconds integer with default 600', () => {
    const def = loadTool('vigil-esql-change-correlation');
    const p = def.configuration.params.max_gap_seconds;
    assert.equal(p.required, false);
    assert.equal(p.type, 'integer');
    assert.equal(p.default, 600);
    assert.equal(def.lookupJoinTechPreview, true);
  });

  it('ioc-sweep requires 4 keyword arrays', () => {
    const def = loadTool('vigil-esql-ioc-sweep');
    const p = def.configuration.params;
    for (const name of ['malicious_ips', 'malicious_domains', 'malicious_hashes', 'malicious_processes']) {
      assert.equal(p[name].required, true, `${name} should be required`);
      assert.equal(p[name].type, 'keyword', `${name} should be keyword type`);
    }
  });

  it('behavioral-anomaly requires known_compromised_user, optional anomaly_threshold', () => {
    const def = loadTool('vigil-esql-behavioral-anomaly');
    const p = def.configuration.params;
    assert.equal(p.known_compromised_user.required, true);
    assert.equal(p.known_compromised_user.type, 'keyword');
    assert.equal(p.anomaly_threshold.required, false);
    assert.equal(p.anomaly_threshold.type, 'double');
    assert.equal(p.anomaly_threshold.default, 8.0);
  });

  it('health-monitor requires service_name + 4 doubles', () => {
    const def = loadTool('vigil-esql-health-monitor');
    const p = def.configuration.params;
    assert.equal(p.service_name.required, true);
    assert.equal(p.service_name.type, 'keyword');
    for (const name of ['baseline_avg', 'baseline_stddev', 'baseline_error_rate', 'baseline_error_stddev']) {
      assert.equal(p[name].required, true, `${name} should be required`);
      assert.equal(p[name].type, 'double', `${name} should be double type`);
    }
  });

  it('dependency-tracer requires service_name', () => {
    const def = loadTool('vigil-esql-dependency-tracer');
    assert.equal(def.configuration.params.service_name.required, true);
    assert.equal(def.configuration.params.service_name.type, 'keyword');
  });

  it('recent-change-detector requires service_name', () => {
    const def = loadTool('vigil-esql-recent-change-detector');
    assert.equal(def.configuration.params.service_name.required, true);
    assert.equal(def.configuration.params.service_name.type, 'keyword');
  });

  it('impact-assessment requires target_service', () => {
    const def = loadTool('vigil-esql-impact-assessment');
    assert.equal(def.configuration.params.target_service.required, true);
    assert.equal(def.configuration.params.target_service.type, 'keyword');
  });

  it('health-comparison requires service_name + 4 doubles', () => {
    const def = loadTool('vigil-esql-health-comparison');
    const p = def.configuration.params;
    assert.equal(p.service_name.required, true);
    assert.equal(p.service_name.type, 'keyword');
    for (const name of ['baseline_avg', 'baseline_stddev', 'max_error_rate', 'min_throughput']) {
      assert.equal(p[name].required, true, `${name} should be required`);
      assert.equal(p[name].type, 'double', `${name} should be double type`);
    }
  });
});
