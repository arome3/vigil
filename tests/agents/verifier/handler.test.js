// Jest test suite for the Verifier agent handler.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/verifier/

import { jest } from '@jest/globals';

// --- Mock external dependencies BEFORE importing handler ---

const mockExecuteEsqlTool = jest.fn();
const mockExecuteSearchTool = jest.fn();
const mockValidateVerifyResponse = jest.fn(() => true);
const mockClientGet = jest.fn();
const mockWaitForStabilization = jest.fn();
const mockEvaluateCriterion = jest.fn();
const mockComputeHealthScore = jest.fn();
const mockBuildFailureAnalysis = jest.fn();

jest.unstable_mockModule('../../../src/tools/esql/executor.js', () => ({
  executeEsqlTool: mockExecuteEsqlTool
}));

jest.unstable_mockModule('../../../src/tools/search/executor.js', () => ({
  executeSearchTool: mockExecuteSearchTool
}));

jest.unstable_mockModule('../../../src/a2a/contracts.js', () => ({
  validateVerifyResponse: mockValidateVerifyResponse,
  ContractValidationError: class extends Error {
    constructor(contract, errors) {
      super(`Contract validation failed [${contract}]: ${errors.join('; ')}`);
      this.name = 'ContractValidationError';
    }
  }
}));

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: {
    get: mockClientGet
  }
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.unstable_mockModule('../../../src/agents/verifier/stabilization.js', () => ({
  waitForStabilization: mockWaitForStabilization
}));

jest.unstable_mockModule('../../../src/agents/verifier/health-scorer.js', () => ({
  evaluateCriterion: mockEvaluateCriterion,
  computeHealthScore: mockComputeHealthScore
}));

jest.unstable_mockModule('../../../src/agents/verifier/failure-analyzer.js', () => ({
  buildFailureAnalysis: mockBuildFailureAnalysis
}));

// Dynamic import after mocks are set up
const { handleVerifyRequest } = await import('../../../src/agents/verifier/handler.js');

// --- Test Helpers ---

function buildValidEnvelope(overrides = {}) {
  return {
    task: 'verify_resolution',
    incident_id: 'INC-2026-TEST1',
    affected_services: ['api-gateway'],
    success_criteria: [
      {
        metric: 'error_rate',
        operator: 'lte',
        threshold: 1.0,
        service_name: 'api-gateway'
      },
      {
        metric: 'avg_latency',
        operator: 'lte',
        threshold: 60000,
        service_name: 'api-gateway'
      }
    ],
    ...overrides
  };
}

/**
 * Build a mock ES|QL columnar result matching the health-comparison tool
 * output, including baseline verdict boolean columns.
 */
function buildHealthResult(metrics = {}) {
  return {
    columns: [
      { name: 'service.name', type: 'keyword' },
      { name: 'current_avg_latency', type: 'double' },
      { name: 'current_error_rate', type: 'double' },
      { name: 'current_throughput', type: 'double' },
      { name: 'current_cpu', type: 'double' },
      { name: 'current_memory', type: 'double' },
      { name: 'latency_within_baseline', type: 'boolean' },
      { name: 'error_rate_acceptable', type: 'boolean' },
      { name: 'throughput_recovered', type: 'boolean' }
    ],
    values: [[
      metrics.service_name || 'api-gateway',
      metrics.avg_latency ?? 45000,
      metrics.error_rate ?? 0.3,
      metrics.throughput ?? 95,
      metrics.cpu ?? 0.4,
      metrics.memory ?? 0.6,
      metrics.latency_within_baseline ?? true,
      metrics.error_rate_acceptable ?? true,
      metrics.throughput_recovered ?? true
    ]],
    took: 12
  };
}

// --- Test Suite ---

describe('vigil-verifier handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    // Default: stabilization resolves instantly
    mockWaitForStabilization.mockResolvedValue(undefined);

    // Default: baselines return empty (graceful degradation)
    mockExecuteSearchTool.mockResolvedValue({ results: [], total: 0, took: 5 });

    // Default: health comparison returns valid columnar data
    mockExecuteEsqlTool.mockResolvedValue(buildHealthResult());

    // Default: evaluateCriterion returns passed
    mockEvaluateCriterion.mockImplementation((criterion) => ({
      metric: criterion.metric,
      current_value: 0.3,
      threshold: criterion.threshold,
      passed: true
    }));

    // Default: health score = 1.0
    mockComputeHealthScore.mockReturnValue(1.0);

    // Default: no failure analysis needed
    mockBuildFailureAnalysis.mockReturnValue(null);

    // Default: incident has reflection_count=0
    mockClientGet.mockResolvedValue({
      _source: { reflection_count: 0 }
    });
  });

  // ── Request Validation ───────────────────────────────────

  describe('Request Validation', () => {
    test('rejects request with wrong task type', async () => {
      const envelope = buildValidEnvelope({ task: 'wrong_task' });
      await expect(handleVerifyRequest(envelope)).rejects.toThrow(
        "Verifier received unknown task: 'wrong_task'"
      );
    });

    test('rejects request with missing incident_id', async () => {
      const envelope = buildValidEnvelope({ incident_id: undefined });
      await expect(handleVerifyRequest(envelope)).rejects.toThrow(
        'missing required field: incident_id'
      );
    });

    test('rejects request with missing affected_services', async () => {
      const envelope = buildValidEnvelope({ affected_services: undefined });
      await expect(handleVerifyRequest(envelope)).rejects.toThrow(
        'missing required field: affected_services'
      );
    });

    test('rejects request with empty success_criteria', async () => {
      const envelope = buildValidEnvelope({ success_criteria: [] });
      await expect(handleVerifyRequest(envelope)).rejects.toThrow(
        'success_criteria'
      );
    });

    test('rejects criterion with invalid operator', async () => {
      const envelope = buildValidEnvelope({
        success_criteria: [{
          metric: 'error_rate',
          operator: 'gt',
          threshold: 1.0,
          service_name: 'api-gateway'
        }]
      });
      await expect(handleVerifyRequest(envelope)).rejects.toThrow(
        "Invalid operator 'gt'"
      );
    });
  });

  // ── Happy Path ──────────────────────────────────────────

  describe('Happy Path', () => {
    test('returns passed=true and health_score=1.0 when all criteria pass', async () => {
      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.passed).toBe(true);
      expect(result.health_score).toBe(1.0);
      expect(result.incident_id).toBe('INC-2026-TEST1');
    });

    test('returns failure_analysis=null when passed=true', async () => {
      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.failure_analysis).toBeNull();
    });

    test('criteria_results array has one entry per success_criterion', async () => {
      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.criteria_results).toHaveLength(2);
      expect(mockEvaluateCriterion).toHaveBeenCalledTimes(2);
    });
  });

  // ── Partial Failure ─────────────────────────────────────

  describe('Partial Failure', () => {
    beforeEach(() => {
      mockEvaluateCriterion
        .mockReturnValueOnce({
          metric: 'error_rate', current_value: 0.3, threshold: 1.0, passed: true
        })
        .mockReturnValueOnce({
          metric: 'avg_latency', current_value: 75000, threshold: 60000, passed: false
        });
      mockComputeHealthScore.mockReturnValue(0.5);
      mockBuildFailureAnalysis.mockReturnValue(
        'Verification failed: 1 of 2 criteria not met (1 passed). ' +
        'Failed metrics: avg_latency: current=75000, threshold=60000. ' +
        'Recommendation: investigate why avg_latency have not recovered.'
      );
    });

    test('returns passed=false when health_score < 0.8', async () => {
      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.passed).toBe(false);
      expect(result.health_score).toBe(0.5);
    });

    test('returns non-null failure_analysis when passed=false', async () => {
      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(typeof result.failure_analysis).toBe('string');
      expect(result.failure_analysis).toContain('Verification failed');
    });

    test('correctly computes health_score as passed_criteria / total_criteria', async () => {
      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.health_score).toBe(0.5);
      expect(mockComputeHealthScore).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ passed: true }),
          expect.objectContaining({ passed: false })
        ])
      );
    });
  });

  // ── Stabilization Wait ──────────────────────────────────

  describe('Stabilization Wait', () => {
    test('waits the configured stabilization period before running health checks', async () => {
      await handleVerifyRequest(buildValidEnvelope());

      expect(mockWaitForStabilization).toHaveBeenCalledTimes(1);
      expect(mockWaitForStabilization).toHaveBeenCalledWith(60);
    });

    test('stabilization completes before health checks begin', async () => {
      const callOrder = [];
      mockWaitForStabilization.mockImplementation(async () => {
        callOrder.push('stabilization');
      });
      mockExecuteEsqlTool.mockImplementation(async () => {
        callOrder.push('health-check');
        return buildHealthResult();
      });

      await handleVerifyRequest(buildValidEnvelope());

      expect(callOrder[0]).toBe('stabilization');
      expect(callOrder).toContain('health-check');
    });
  });

  // ── Graceful Degradation ────────────────────────────────

  describe('Graceful Degradation', () => {
    test('marks criterion as failed when health comparison tool throws', async () => {
      mockExecuteEsqlTool.mockRejectedValue(new Error('ES|QL query timeout'));

      mockEvaluateCriterion.mockImplementation((criterion) => ({
        metric: criterion.metric,
        current_value: null,
        threshold: criterion.threshold,
        passed: false
      }));
      mockComputeHealthScore.mockReturnValue(0);
      mockBuildFailureAnalysis.mockReturnValue(
        'Verification failed: 2 of 2 criteria not met (0 passed).'
      );

      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.passed).toBe(false);
      expect(result.criteria_results.every(c => c.passed === false)).toBe(true);
      expect(result.criteria_results.every(c => c.current_value === null)).toBe(true);
    });

    test('proceeds when baselines are unavailable', async () => {
      mockExecuteSearchTool.mockRejectedValue(new Error('Index not found'));

      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.incident_id).toBe('INC-2026-TEST1');
      expect(result.criteria_results).toHaveLength(2);
    });

    test('continues checking remaining criteria when one service fails', async () => {
      const envelope = buildValidEnvelope({
        affected_services: ['api-gateway', 'payment-service'],
        success_criteria: [
          { metric: 'error_rate', operator: 'lte', threshold: 1.0, service_name: 'api-gateway' },
          { metric: 'error_rate', operator: 'lte', threshold: 2.0, service_name: 'payment-service' }
        ]
      });

      mockExecuteEsqlTool
        .mockRejectedValueOnce(new Error('ES timeout'))
        .mockResolvedValueOnce(buildHealthResult({ service_name: 'payment-service' }));

      mockEvaluateCriterion
        .mockReturnValueOnce({
          metric: 'error_rate', current_value: null, threshold: 1.0, passed: false
        })
        .mockReturnValueOnce({
          metric: 'error_rate', current_value: 0.5, threshold: 2.0, passed: true
        });
      mockComputeHealthScore.mockReturnValue(0.5);
      mockBuildFailureAnalysis.mockReturnValue('Verification failed: 1 of 2 criteria not met.');

      const result = await handleVerifyRequest(envelope);

      expect(result.criteria_results).toHaveLength(2);
      expect(mockEvaluateCriterion).toHaveBeenCalledTimes(2);
    });
  });

  // ── Response Validation ─────────────────────────────────

  describe('Response Validation', () => {
    test('response passes validateVerifyResponse() contract validation', async () => {
      await handleVerifyRequest(buildValidEnvelope());

      expect(mockValidateVerifyResponse).toHaveBeenCalledTimes(1);
      expect(mockValidateVerifyResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          incident_id: 'INC-2026-TEST1',
          iteration: expect.any(Number),
          health_score: expect.any(Number),
          passed: expect.any(Boolean),
          criteria_results: expect.any(Array)
        })
      );
    });

    test('iteration field reflects the incident reflection_count + 1', async () => {
      mockClientGet.mockResolvedValue({
        _source: { reflection_count: 2 }
      });

      const result = await handleVerifyRequest(buildValidEnvelope());

      expect(result.iteration).toBe(3);
    });
  });

  // ── Deadline ────────────────────────────────────────────

  describe('Deadline', () => {
    test('returns failed verification when real deadline fires', async () => {
      // Injectable deadlineMs exercises the actual setTimeout + Promise.race path.
      // Health checks take 500ms, deadline fires at 50ms.
      mockExecuteEsqlTool.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(buildHealthResult()), 500))
      );

      const result = await handleVerifyRequest(buildValidEnvelope(), { deadlineMs: 50 });

      expect(result.passed).toBe(false);
      expect(result.health_score).toBe(0);
      expect(result.failure_analysis).toContain('deadline');
      expect(result.criteria_results).toEqual([]);
      expect(result.incident_id).toBe('INC-2026-TEST1');
    });

    test('deadline uses correct iteration from incident document', async () => {
      mockClientGet.mockResolvedValue({
        _source: { reflection_count: 2 }
      });
      mockExecuteEsqlTool.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(buildHealthResult()), 500))
      );

      const result = await handleVerifyRequest(buildValidEnvelope(), { deadlineMs: 10 });

      // Verify C2 fix: degraded response uses real iteration, not hardcoded 1
      expect(result.iteration).toBe(3);
      expect(result.passed).toBe(false);
    });

    test('non-deadline errors produce accurate failure_analysis', async () => {
      // An error escaping runHealthChecks (e.g., from computeHealthScore which
      // has no try/catch) should NOT say "deadline exceeded" — it should
      // report the actual error message.
      mockComputeHealthScore.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      });

      const result = await handleVerifyRequest(buildValidEnvelope(), { deadlineMs: 5000 });

      expect(result.passed).toBe(false);
      expect(result.failure_analysis).toContain('Verification error');
      expect(result.failure_analysis).not.toContain('deadline');
    });

    test('health checks run in parallel within deadline budget', async () => {
      const envelope = buildValidEnvelope({
        affected_services: ['svc-1', 'svc-2', 'svc-3'],
        success_criteria: [
          { metric: 'error_rate', operator: 'lte', threshold: 1.0, service_name: 'svc-1' },
          { metric: 'error_rate', operator: 'lte', threshold: 1.0, service_name: 'svc-2' },
          { metric: 'error_rate', operator: 'lte', threshold: 1.0, service_name: 'svc-3' }
        ]
      });

      // Each query takes 100ms. Sequential = 300ms > 200ms deadline.
      // Parallel = ~100ms < 200ms deadline. If queries ran sequentially,
      // the deadline would fire.
      mockExecuteEsqlTool.mockImplementation(
        () => new Promise(resolve =>
          setTimeout(() => resolve(buildHealthResult()), 100)
        )
      );

      const result = await handleVerifyRequest(envelope, { deadlineMs: 200 });

      expect(mockExecuteEsqlTool).toHaveBeenCalledTimes(3);
      expect(result.criteria_results).toHaveLength(3);
      // Did NOT hit deadline — proves parallel execution
      expect(result.health_score).not.toBe(0);
    });
  });
});
