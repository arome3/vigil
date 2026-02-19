// Unit tests for the Executor audit logger.

import { jest } from '@jest/globals';

const mockIndex = jest.fn();

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: { index: mockIndex }
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { logAuditRecord } = await import('../../../src/agents/executor/audit-logger.js');

describe('audit-logger', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIndex.mockResolvedValue({ result: 'created' });
  });

  // ── Successful indexing ────────────────────────────────

  test('indexes document to vigil-actions with refresh: false', async () => {
    await logAuditRecord({ action_id: 'ACT-2026-TEST1', execution_status: 'completed' });

    expect(mockIndex).toHaveBeenCalledTimes(1);
    const call = mockIndex.mock.calls[0][0];
    expect(call.index).toBe('vigil-actions');
    expect(call.refresh).toBe(false);
  });

  test('adds @timestamp and agent_name to document', async () => {
    await logAuditRecord({ action_id: 'ACT-2026-TEST1', execution_status: 'completed' });

    const doc = mockIndex.mock.calls[0][0].document;
    expect(doc['@timestamp']).toBeDefined();
    expect(doc.agent_name).toBe('vigil-executor');
  });

  test('preserves all record fields in document', async () => {
    const record = {
      action_id: 'ACT-2026-AAAAA',
      incident_id: 'INC-2026-00001',
      action_type: 'remediation',
      action_detail: 'Rollback deploy',
      target_system: 'kubernetes',
      target_asset: 'api-gateway',
      approval_required: false,
      approved_by: null,
      approved_at: null,
      execution_status: 'completed',
      started_at: '2026-02-17T14:00:00Z',
      completed_at: '2026-02-17T14:01:00Z',
      duration_ms: 60000,
      result_summary: 'Rollback succeeded',
      rollback_available: true,
      error_message: null,
      workflow_id: 'vigil-wf-remediation'
    };

    await logAuditRecord(record);

    const doc = mockIndex.mock.calls[0][0].document;
    expect(doc.action_id).toBe('ACT-2026-AAAAA');
    expect(doc.incident_id).toBe('INC-2026-00001');
    expect(doc.action_type).toBe('remediation');
    expect(doc.duration_ms).toBe(60000);
    expect(doc.workflow_id).toBe('vigil-wf-remediation');
  });

  test('@timestamp is a valid ISO 8601 string', async () => {
    await logAuditRecord({ action_id: 'ACT-2026-TEST1', execution_status: 'completed' });

    const doc = mockIndex.mock.calls[0][0].document;
    const parsed = new Date(doc['@timestamp']);
    expect(parsed.toISOString()).toBe(doc['@timestamp']);
  });

  // ── Error resilience ───────────────────────────────────

  test('does not throw when client.index rejects', async () => {
    mockIndex.mockRejectedValue(new Error('Connection refused'));

    // Must not throw
    await expect(logAuditRecord({
      action_id: 'ACT-2026-FAIL1',
      execution_status: 'failed'
    })).resolves.toBeUndefined();
  });

  test('does not throw when client.index throws synchronously', async () => {
    mockIndex.mockImplementation(() => { throw new Error('Sync kaboom'); });

    await expect(logAuditRecord({
      action_id: 'ACT-2026-FAIL2',
      execution_status: 'failed'
    })).resolves.toBeUndefined();
  });

  test('returns undefined on success', async () => {
    const result = await logAuditRecord({
      action_id: 'ACT-2026-TEST1',
      execution_status: 'completed'
    });
    expect(result).toBeUndefined();
  });

  // ── Retry behavior ──────────────────────────────────────

  describe('retry behavior', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('retries on 503 and succeeds on second attempt', async () => {
      const err503 = new Error('Service Unavailable');
      err503.meta = { statusCode: 503 };
      mockIndex
        .mockRejectedValueOnce(err503)
        .mockResolvedValueOnce({ result: 'created' });

      const promise = logAuditRecord({ action_id: 'ACT-2026-RETRY1', execution_status: 'completed' });
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockIndex).toHaveBeenCalledTimes(2);
    });

    test('retries on 429 rate limit and succeeds', async () => {
      const err429 = new Error('Too Many Requests');
      err429.meta = { statusCode: 429 };
      mockIndex
        .mockRejectedValueOnce(err429)
        .mockResolvedValueOnce({ result: 'created' });

      const promise = logAuditRecord({ action_id: 'ACT-2026-RETRY2', execution_status: 'completed' });
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockIndex).toHaveBeenCalledTimes(2);
    });

    test('does not retry non-retryable errors', async () => {
      // Error without status code — isRetryable returns false
      mockIndex.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      // No fake timer advancement needed — should resolve immediately
      await expect(logAuditRecord({
        action_id: 'ACT-2026-NORETRY',
        execution_status: 'failed'
      })).resolves.toBeUndefined();

      expect(mockIndex).toHaveBeenCalledTimes(1);
    });
  });
});
