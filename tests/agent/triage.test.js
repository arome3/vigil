// Triage agent handler tests.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agent/triage.test.js

import { jest } from '@jest/globals';

// --- Mock setup (BEFORE handler import) ---

const mockExecuteEsqlTool = jest.fn();
const mockExecuteSearchTool = jest.fn();
const mockValidateTriageResponse = jest.fn(() => true);
const mockUpdateByQuery = jest.fn(async () => ({ updated: 1 }));

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../../src/tools/esql/executor.js', () => ({
  executeEsqlTool: mockExecuteEsqlTool
}));

jest.unstable_mockModule('../../src/tools/search/executor.js', () => ({
  executeSearchTool: mockExecuteSearchTool
}));

jest.unstable_mockModule('../../src/a2a/contracts.js', () => ({
  validateTriageResponse: mockValidateTriageResponse,
  ContractValidationError: class extends Error {
    constructor(contract, errors) {
      super(`Contract validation failed [${contract}]: ${errors.join('; ')}`);
      this.name = 'ContractValidationError';
    }
  }
}));

jest.unstable_mockModule('../../src/utils/elastic-client.js', () => ({
  default: {
    updateByQuery: mockUpdateByQuery
  }
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createLogger: () => silentLogger
}));

jest.unstable_mockModule('../../src/utils/env.js', () => ({
  parseThreshold: (_, defaultVal) => defaultVal
}));

// Dynamic import after all mocks
const { handleTriageRequest } = await import('../../src/agents/triage/handler.js');

// --- Fixtures ---

import {
  buildAlert,
  buildTriageEnvelope,
  buildEnrichmentResult,
  buildFpRateResult,
  buildAssetResult
} from '../framework/fixtures.js';

// --- Helpers ---

function setupHighPriorityMocks() {
  mockExecuteEsqlTool.mockImplementation(async (toolName) => {
    if (toolName === 'vigil-esql-alert-enrichment') {
      return buildEnrichmentResult({ risk_signal: 72.5 });
    }
    if (toolName === 'vigil-esql-historical-fp-rate') {
      return buildFpRateResult(0.02);
    }
    throw new Error(`Unexpected tool: ${toolName}`);
  });

  mockExecuteSearchTool.mockImplementation(async () => buildAssetResult('tier-1'));
}

function setupLowPriorityMocks() {
  mockExecuteEsqlTool.mockImplementation(async (toolName) => {
    if (toolName === 'vigil-esql-alert-enrichment') {
      return buildEnrichmentResult({ risk_signal: 1.5, event_count: 2, unique_destinations: 1, failed_auths: 0 });
    }
    if (toolName === 'vigil-esql-historical-fp-rate') {
      return buildFpRateResult(0.85);
    }
    throw new Error(`Unexpected tool: ${toolName}`);
  });

  mockExecuteSearchTool.mockImplementation(async () => buildAssetResult('tier-3'));
}

function setupMidRangeMocks() {
  mockExecuteEsqlTool.mockImplementation(async (toolName) => {
    if (toolName === 'vigil-esql-alert-enrichment') {
      return buildEnrichmentResult({ risk_signal: 30, event_count: 15, unique_destinations: 5, failed_auths: 3 });
    }
    if (toolName === 'vigil-esql-historical-fp-rate') {
      return buildFpRateResult(0.3);
    }
    throw new Error(`Unexpected tool: ${toolName}`);
  });

  mockExecuteSearchTool.mockImplementation(async () => buildAssetResult('tier-2'));
}

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
});

describe('handleTriageRequest', () => {
  // ─── Scenario 1: High-priority → investigate ─────────────

  describe('high-priority alert (critical/tier-1/72.5/0.02)', () => {
    it('returns investigate disposition with score >= 0.7', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({
        severity_original: 'critical',
        affected_asset_id: 'asset-web-prod-01'
      });

      const result = await handleTriageRequest(envelope);

      expect(result.alert_id).toBe('ALERT-TEST-001');
      expect(result.priority_score).toBeGreaterThanOrEqual(0.7);
      expect(result.disposition).toBe('investigate');
      expect(result.suppression_reason).toBeNull();
    });

    it('populates enrichment fields with correct extracted values', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({ severity_original: 'critical' });
      const result = await handleTriageRequest(envelope);

      expect(result.enrichment).toBeDefined();
      expect(result.enrichment.risk_signal).toBe(72.5);
      expect(result.enrichment.historical_fp_rate).toBeCloseTo(0.02, 1);
      expect(result.enrichment.asset_criticality).toBe('tier-1');
      // Value assertions — not just type checks. These verify the column
      // extraction pipeline actually reads from the mock ES|QL result
      // (buildEnrichmentResult defaults: event_count=45, unique_destinations=12, failed_auths=8)
      expect(result.enrichment.correlated_event_count).toBe(45);
      expect(result.enrichment.unique_destinations).toBe(12);
      expect(result.enrichment.failed_auth_count).toBe(8);
    });
  });

  // ─── Scenario 2: Low-priority → suppress ──────────────────

  describe('low-priority alert (low/tier-3/1.5/0.85)', () => {
    it('returns suppress disposition with score < 0.4', async () => {
      setupLowPriorityMocks();

      const envelope = buildTriageEnvelope({
        severity_original: 'low',
        affected_asset_id: 'asset-dev-vm-01'
      });

      const result = await handleTriageRequest(envelope);

      expect(result.priority_score).toBeLessThan(0.4);
      expect(result.disposition).toBe('suppress');
      expect(result.suppression_reason).toBeTruthy();
      expect(typeof result.suppression_reason).toBe('string');
    });
  });

  // ─── Scenario 3: Mid-range → queue ────────────────────────

  describe('mid-range alert (medium/tier-2/30/0.3)', () => {
    it('returns queue disposition with score between 0.4 and 0.7', async () => {
      setupMidRangeMocks();

      const envelope = buildTriageEnvelope({
        severity_original: 'medium',
        affected_asset_id: 'asset-db-staging-01'
      });

      const result = await handleTriageRequest(envelope);

      expect(result.priority_score).toBeGreaterThanOrEqual(0.4);
      expect(result.priority_score).toBeLessThan(0.7);
      expect(result.disposition).toBe('queue');
      expect(result.suppression_reason).toBeNull();
    });
  });

  // ─── Scenario 4: Graceful degradation ─────────────────────

  describe('graceful degradation when enrichment tool fails', () => {
    it('returns valid response with defaults when enrichment rejects', async () => {
      mockExecuteEsqlTool.mockImplementation(async (toolName) => {
        if (toolName === 'vigil-esql-alert-enrichment') {
          throw new Error('ES|QL timeout');
        }
        if (toolName === 'vigil-esql-historical-fp-rate') {
          return buildFpRateResult(0.1);
        }
        throw new Error(`Unexpected tool: ${toolName}`);
      });

      mockExecuteSearchTool.mockImplementation(async () => buildAssetResult('tier-2'));

      const envelope = buildTriageEnvelope({ severity_original: 'high' });
      const result = await handleTriageRequest(envelope);

      // Should still return a valid response using defaults for failed enrichment
      expect(result.alert_id).toBe('ALERT-TEST-001');
      expect(typeof result.priority_score).toBe('number');
      expect(['investigate', 'queue', 'suppress']).toContain(result.disposition);
      expect(result.enrichment.risk_signal).toBe(0); // default
      expect(result.enrichment.correlated_event_count).toBe(0); // default
    });
  });

  // ─── Scenario 5: All tools fail ───────────────────────────

  describe('all tools fail', () => {
    it('returns valid response with all defaults', async () => {
      mockExecuteEsqlTool.mockRejectedValue(new Error('ES cluster unavailable'));
      mockExecuteSearchTool.mockRejectedValue(new Error('ES cluster unavailable'));

      const envelope = buildTriageEnvelope({ severity_original: 'medium' });
      const result = await handleTriageRequest(envelope);

      expect(result.alert_id).toBe('ALERT-TEST-001');
      expect(typeof result.priority_score).toBe('number');
      expect(['investigate', 'queue', 'suppress']).toContain(result.disposition);
      // Defaults: risk_signal=0, fp_rate=0, criticality=tier-3
      expect(result.enrichment.risk_signal).toBe(0);
      expect(result.enrichment.historical_fp_rate).toBe(0);
      expect(result.enrichment.asset_criticality).toBe('tier-3');
    });
  });

  // ─── Request validation ───────────────────────────────────

  describe('request validation', () => {
    it('rejects wrong task type', async () => {
      await expect(
        handleTriageRequest({ task: 'wrong_task', alert: buildAlert() })
      ).rejects.toThrow(/Invalid task.*expected 'enrich_and_score'/);
    });

    it('rejects missing alert_id', async () => {
      await expect(
        handleTriageRequest({ task: 'enrich_and_score', alert: {} })
      ).rejects.toThrow(/Missing required field.*alert_id/);
    });

    it('rejects null envelope', async () => {
      await expect(
        handleTriageRequest(null)
      ).rejects.toThrow();
    });
  });

  // ─── Contract self-validation ─────────────────────────────

  describe('contract self-validation', () => {
    it('calls validateTriageResponse on the response', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({ severity_original: 'critical' });
      await handleTriageRequest(envelope);

      expect(mockValidateTriageResponse).toHaveBeenCalledTimes(1);
      const [arg] = mockValidateTriageResponse.mock.calls[0];
      expect(arg.alert_id).toBe('ALERT-TEST-001');
      expect(typeof arg.priority_score).toBe('number');
      expect(arg.enrichment).toBeDefined();
    });
  });

  // ─── Missing affected_asset_id ────────────────────────────

  describe('missing affected_asset_id', () => {
    it('skips search tool and defaults to tier-3', async () => {
      mockExecuteEsqlTool.mockImplementation(async (toolName) => {
        if (toolName === 'vigil-esql-alert-enrichment') {
          return buildEnrichmentResult({ risk_signal: 50 });
        }
        if (toolName === 'vigil-esql-historical-fp-rate') {
          return buildFpRateResult(0.1);
        }
        throw new Error(`Unexpected tool: ${toolName}`);
      });

      const envelope = buildTriageEnvelope({
        severity_original: 'high',
        affected_asset_id: undefined
      });

      const result = await handleTriageRequest(envelope);

      // Search tool should not have been called
      expect(mockExecuteSearchTool).not.toHaveBeenCalled();
      expect(result.enrichment.asset_criticality).toBe('tier-3');
    });
  });

  // ─── Fire-and-forget alert update ─────────────────────────

  describe('fire-and-forget alert document update', () => {
    it('calls updateByQuery after returning response', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({ severity_original: 'critical' });
      await handleTriageRequest(envelope);

      // Allow microtask queue to flush the fire-and-forget promise
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockUpdateByQuery).toHaveBeenCalledTimes(1);
      const [args] = mockUpdateByQuery.mock.calls[0];
      expect(args.index).toBe('vigil-alerts-*');
      expect(args.body.query.term.alert_id).toBe('ALERT-TEST-001');
    });

    it('does not throw if updateByQuery fails', async () => {
      setupHighPriorityMocks();
      mockUpdateByQuery.mockRejectedValue(new Error('ES write error'));

      const envelope = buildTriageEnvelope({ severity_original: 'critical' });
      // Should not throw — the update is fire-and-forget
      const result = await handleTriageRequest(envelope);
      expect(result.alert_id).toBe('ALERT-TEST-001');

      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  // ─── Tool invocation correctness ──────────────────────────

  describe('tool invocations', () => {
    it('passes correct params to enrichment tool', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({
        source_ip: '192.168.1.100',
        source_user: 'bob'
      });
      await handleTriageRequest(envelope);

      const enrichCall = mockExecuteEsqlTool.mock.calls.find(
        c => c[0] === 'vigil-esql-alert-enrichment'
      );
      expect(enrichCall).toBeDefined();
      expect(enrichCall[1]).toEqual({
        source_ip: '192.168.1.100',
        username: 'bob'
      });
    });

    it('passes correct params to FP rate tool', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({ rule_id: 'rule-malware-detected' });
      await handleTriageRequest(envelope);

      const fpCall = mockExecuteEsqlTool.mock.calls.find(
        c => c[0] === 'vigil-esql-historical-fp-rate'
      );
      expect(fpCall).toBeDefined();
      expect(fpCall[1]).toEqual({ rule_id: 'rule-malware-detected' });
    });

    it('passes affected_asset_id to search tool', async () => {
      setupHighPriorityMocks();

      const envelope = buildTriageEnvelope({ affected_asset_id: 'asset-db-01' });
      await handleTriageRequest(envelope);

      expect(mockExecuteSearchTool).toHaveBeenCalledWith(
        'vigil-search-asset-criticality',
        'asset-db-01'
      );
    });
  });

  // ─── Empty ES|QL results (columns present, no rows) ───────

  describe('empty ES|QL results', () => {
    it('uses defaults when enrichment returns columns but no rows', async () => {
      mockExecuteEsqlTool.mockImplementation(async (toolName) => {
        if (toolName === 'vigil-esql-alert-enrichment') {
          // Valid ES|QL shape: columns present but no matching data
          return {
            columns: [
              { name: 'event_count', type: 'long' },
              { name: 'unique_destinations', type: 'long' },
              { name: 'failed_auths', type: 'long' },
              { name: 'risk_signal', type: 'double' }
            ],
            values: [], // no rows
            took: 5
          };
        }
        if (toolName === 'vigil-esql-historical-fp-rate') {
          return {
            columns: [{ name: 'fp_rate', type: 'double' }],
            values: [], // no rows — first-seen rule
            took: 3
          };
        }
        throw new Error(`Unexpected tool: ${toolName}`);
      });

      mockExecuteSearchTool.mockImplementation(async () => ({
        results: [], // no matching asset
        total: 0,
        took: 2
      }));

      const envelope = buildTriageEnvelope({ severity_original: 'high' });
      const result = await handleTriageRequest(envelope);

      // All extractors should return defaults for empty results
      expect(result.enrichment.correlated_event_count).toBe(0);
      expect(result.enrichment.unique_destinations).toBe(0);
      expect(result.enrichment.failed_auth_count).toBe(0);
      expect(result.enrichment.risk_signal).toBe(0);
      expect(result.enrichment.historical_fp_rate).toBe(0);
      expect(result.enrichment.asset_criticality).toBe('tier-3');
    });
  });

  // ─── Deadline racing ──────────────────────────────────────

  describe('deadline racing', () => {
    it('degrades gracefully when tools exceed deadline', async () => {
      // Simulate tools that hang forever — they create long timers
      // that we must clean up after the test.
      const pendingTimers = [];
      mockExecuteEsqlTool.mockImplementation(async () => {
        return new Promise((resolve) => {
          const id = setTimeout(resolve, 60000);
          pendingTimers.push(id);
        });
      });
      mockExecuteSearchTool.mockImplementation(async () => {
        return new Promise((resolve) => {
          const id = setTimeout(resolve, 60000);
          pendingTimers.push(id);
        });
      });

      try {
        // The handler's 5s deadline will fire before the mock tools resolve.
        const result = await handleTriageRequest(
          buildTriageEnvelope({ severity_original: 'medium' })
        );

        // After deadline, handler should return valid response with defaults
        expect(result.alert_id).toBe('ALERT-TEST-001');
        expect(typeof result.priority_score).toBe('number');
        expect(['investigate', 'queue', 'suppress']).toContain(result.disposition);
        expect(result.enrichment.risk_signal).toBe(0);
        expect(result.enrichment.historical_fp_rate).toBe(0);
        expect(result.enrichment.asset_criticality).toBe('tier-3');
      } finally {
        // Clean up hanging timers so Jest can exit cleanly
        pendingTimers.forEach(id => clearTimeout(id));
      }
    }, 10000); // extend timeout for this test
  });
});
