// Unit tests for the Executor approval gate.

import { jest } from '@jest/globals';

const mockSendA2AMessage = jest.fn();
const mockCreateEnvelope = jest.fn();
const mockSearch = jest.fn();

/** Re-apply the createEnvelope implementation (resetAllMocks clears it). */
function restoreCreateEnvelope() {
  mockCreateEnvelope.mockImplementation((from, to, corr, payload) => ({
    message_id: 'msg-test',
    from_agent: from,
    to_agent: to,
    timestamp: new Date().toISOString(),
    correlation_id: corr,
    payload
  }));
}

jest.unstable_mockModule('../../../src/a2a/router.js', () => ({
  sendA2AMessage: mockSendA2AMessage
}));

jest.unstable_mockModule('../../../src/a2a/message-envelope.js', () => ({
  createEnvelope: mockCreateEnvelope
}));

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: { search: mockSearch }
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { checkApprovalGate } = await import('../../../src/agents/executor/approval-gate.js');

// --- Helpers ---

const SAMPLE_ACTION = {
  action_type: 'remediation',
  description: 'Rollback api-gateway',
  target_system: 'kubernetes',
  target_asset: 'api-gateway'
};

/** Fast options to keep tests quick — 300ms timeout, 10ms poll. */
const FAST_OPTIONS = { timeoutMinutes: 0.005, pollIntervalMs: 10 };

function buildSearchResponse(value, user = '@sre-oncall') {
  if (!value) return { hits: { hits: [] } };
  return {
    hits: {
      hits: [{
        _source: {
          incident_id: 'INC-2026-TEST1',
          action_id: 'ACT-2026-AAAAA',
          value,
          user,
          timestamp: '2026-02-17T14:24:15Z'
        }
      }]
    }
  };
}

// --- Tests ---

describe('approval-gate', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    restoreCreateEnvelope();
    mockSendA2AMessage.mockResolvedValue({ ok: true });
  });

  // ── Approval request dispatch ──────────────────────────

  describe('approval request dispatch', () => {
    test('sends approval envelope to vigil-wf-approval', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve'));

      await checkApprovalGate('INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS);

      expect(mockSendA2AMessage).toHaveBeenCalledTimes(1);
      expect(mockSendA2AMessage).toHaveBeenCalledWith(
        'vigil-wf-approval',
        expect.objectContaining({
          to_agent: 'vigil-wf-approval',
          payload: expect.objectContaining({
            task: 'request_approval',
            incident_id: 'INC-2026-TEST1',
            action_id: 'ACT-2026-AAAAA',
            action_description: 'Rollback api-gateway'
          })
        }),
        { timeout: 30_000 }
      );
    });

    test('throws descriptive error when approval dispatch fails', async () => {
      mockSendA2AMessage.mockRejectedValue(new Error('Slack webhook down'));

      await expect(
        checkApprovalGate('INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS)
      ).rejects.toThrow('Failed to dispatch approval request for action ACT-2026-AAAAA');
    });
  });

  // ── Polling outcomes ───────────────────────────────────

  describe('polling outcomes', () => {
    test('returns approved when poll finds approve document', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve', '@security-lead'));

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );

      expect(result.status).toBe('approved');
      expect(result.decided_by).toBe('@security-lead');
      expect(result.decided_at).toBe('2026-02-17T14:24:15Z');
    });

    test('returns rejected when poll finds reject document', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('reject', '@ciso'));

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );

      expect(result.status).toBe('rejected');
      expect(result.decided_by).toBe('@ciso');
    });

    test('returns timeout when deadline expires with no decision', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse(null));

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );

      expect(result.status).toBe('timeout');
      expect(result.decided_by).toBeNull();
      expect(result.decided_at).toBeNull();
    });

    test('continues polling on more_info response', async () => {
      // First poll: more_info, second poll: approve
      mockSearch
        .mockResolvedValueOnce(buildSearchResponse('more_info'))
        .mockResolvedValue(buildSearchResponse('approve'));

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );

      expect(result.status).toBe('approved');
      expect(mockSearch).toHaveBeenCalledTimes(2);
    });

    test('defaults decided_by to unknown when user field is missing', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              incident_id: 'INC-2026-TEST1',
              action_id: 'ACT-2026-AAAAA',
              value: 'approve',
              timestamp: '2026-02-17T14:24:15Z'
              // user field missing
            }
          }]
        }
      });

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );
      expect(result.decided_by).toBe('unknown');
    });
  });

  // ── Query structure ────────────────────────────────────

  describe('query structure', () => {
    test('polls with term filters on both incident_id and action_id', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve'));

      await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-BBBBB', FAST_OPTIONS
      );

      const query = mockSearch.mock.calls[0][0].query;
      expect(query.bool.filter).toEqual(
        expect.arrayContaining([
          { term: { incident_id: 'INC-2026-TEST1' } },
          { term: { action_id: 'ACT-2026-BBBBB' } }
        ])
      );
    });

    test('sorts by timestamp desc and limits to 1 result', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve'));

      await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );

      const searchArgs = mockSearch.mock.calls[0][0];
      expect(searchArgs.sort).toEqual([{ timestamp: 'desc' }]);
      expect(searchArgs.size).toBe(1);
    });
  });

  // ── Severity derivation ────────────────────────────────

  describe('severity derivation', () => {
    beforeEach(() => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve'));
    });

    test.each([
      ['containment', 'critical'],
      ['remediation', 'high'],
      ['communication', 'low'],
      ['documentation', 'low']
    ])('action_type %s → severity %s', async (actionType, expectedSeverity) => {
      const action = { ...SAMPLE_ACTION, action_type: actionType };
      await checkApprovalGate('INC-2026-TEST1', action, 'ACT-2026-AAAAA', FAST_OPTIONS);

      const payload = mockCreateEnvelope.mock.calls[0][3];
      expect(payload.severity).toBe(expectedSeverity);
    });

    test('falls back to high for unknown action_type', async () => {
      const action = { ...SAMPLE_ACTION, action_type: 'investigation' };
      await checkApprovalGate('INC-2026-TEST1', action, 'ACT-2026-AAAAA', FAST_OPTIONS);

      const payload = mockCreateEnvelope.mock.calls[0][3];
      expect(payload.severity).toBe('high');
    });
  });

  // ── Transient error resilience ─────────────────────────

  describe('transient error resilience', () => {
    test('recovers from single transient polling error', async () => {
      mockSearch
        .mockRejectedValueOnce(new Error('ES cluster rebalancing'))
        .mockResolvedValue(buildSearchResponse('approve'));

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS
      );
      expect(result.status).toBe('approved');
    });

    test('throws after 3 consecutive polling failures', async () => {
      mockSearch.mockRejectedValue(new Error('ES unreachable'));

      await expect(
        checkApprovalGate('INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA', FAST_OPTIONS)
      ).rejects.toThrow('Approval polling failed 3 consecutive times');
    });

    test('resets error counter after successful poll', async () => {
      // Fail, succeed (empty), fail, succeed (empty), fail, approve
      mockSearch
        .mockRejectedValueOnce(new Error('err1'))
        .mockResolvedValueOnce(buildSearchResponse(null))   // resets counter
        .mockRejectedValueOnce(new Error('err2'))
        .mockResolvedValueOnce(buildSearchResponse(null))   // resets counter
        .mockRejectedValueOnce(new Error('err3'))
        .mockResolvedValue(buildSearchResponse('approve'));

      const result = await checkApprovalGate(
        'INC-2026-TEST1', SAMPLE_ACTION, 'ACT-2026-AAAAA',
        { timeoutMinutes: 0.05, pollIntervalMs: 5 }  // slightly longer for 6 polls
      );
      expect(result.status).toBe('approved');
    });
  });
});
