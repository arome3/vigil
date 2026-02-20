// Unit tests for the polling-fallback module.

import { jest } from '@jest/globals';

const mockSearch = jest.fn();

jest.unstable_mockModule('../../src/utils/elastic-client.js', () => ({
  default: { search: mockSearch }
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { pollForApproval } = await import('../../src/workflows/polling-fallback.js');

// --- Helpers ---

const FAST_OPTIONS = { timeoutMinutes: 0.005, pollIntervalMs: 10, maxPollErrors: 3 };

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
          '@timestamp': '2026-02-17T14:24:15Z'
        }
      }]
    }
  };
}

// --- Tests ---

describe('polling-fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('successful outcomes', () => {
    test('returns approved when poll finds "approve" document', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve', '@security-lead'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);

      expect(result.status).toBe('approved');
      expect(result.decided_by).toBe('@security-lead');
      expect(result.decided_at).toBe('2026-02-17T14:24:15Z');
    });

    test('returns approved when poll finds "approved" document (defensive)', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approved'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.status).toBe('approved');
    });

    test('returns rejected when poll finds "reject" document', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('reject', '@ciso'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);

      expect(result.status).toBe('rejected');
      expect(result.decided_by).toBe('@ciso');
    });

    test('returns rejected when poll finds "rejected" document (defensive)', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('rejected'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.status).toBe('rejected');
    });

    test('returns timeout when deadline expires with no decision', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse(null));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);

      expect(result.status).toBe('timeout');
      expect(result.decided_by).toBeNull();
      expect(result.decided_at).toBeNull();
    });
  });

  describe('more_info handling', () => {
    test('continues polling on more_info response', async () => {
      mockSearch
        .mockResolvedValueOnce(buildSearchResponse('more_info'))
        .mockResolvedValue(buildSearchResponse('approve'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.status).toBe('approved');
    });

    test('continues polling on "info" response (defensive)', async () => {
      mockSearch
        .mockResolvedValueOnce(buildSearchResponse('info'))
        .mockResolvedValue(buildSearchResponse('reject'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.status).toBe('rejected');
    });

    test('returns timeout after repeated more_info responses', async () => {
      // All polls return more_info — should eventually timeout
      mockSearch.mockResolvedValue(buildSearchResponse('more_info'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.status).toBe('timeout');
      expect(result.decided_by).toBeNull();
      expect(result.decided_at).toBeNull();
    });
  });

  describe('query structure', () => {
    test('polls with term filters on both incident_id and action_id', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve'));

      await pollForApproval('INC-2026-TEST1', 'ACT-2026-BBBBB', FAST_OPTIONS);

      const query = mockSearch.mock.calls[0][0].query;
      expect(query.bool.filter).toEqual(
        expect.arrayContaining([
          { term: { incident_id: 'INC-2026-TEST1' } },
          { term: { action_id: 'ACT-2026-BBBBB' } }
        ])
      );
    });

    test('sorts by @timestamp desc and limits to 1 result', async () => {
      mockSearch.mockResolvedValue(buildSearchResponse('approve'));

      await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);

      const searchArgs = mockSearch.mock.calls[0][0];
      expect(searchArgs.sort).toEqual([{ '@timestamp': 'desc' }]);
      expect(searchArgs.size).toBe(1);
    });
  });

  describe('error resilience', () => {
    test('recovers from a single transient polling error', async () => {
      mockSearch
        .mockRejectedValueOnce(new Error('cluster rebalancing'))
        .mockResolvedValue(buildSearchResponse('approve'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.status).toBe('approved');
    });

    test('throws after maxPollErrors consecutive failures', async () => {
      mockSearch.mockRejectedValue(new Error('ES unreachable'));

      await expect(
        pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS)
      ).rejects.toThrow('Approval polling failed 3 consecutive times');
    });

    test('resets error counter after successful poll', async () => {
      mockSearch
        .mockRejectedValueOnce(new Error('err1'))
        .mockResolvedValueOnce(buildSearchResponse(null))
        .mockRejectedValueOnce(new Error('err2'))
        .mockResolvedValue(buildSearchResponse('approve'));

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', {
        timeoutMinutes: 0.05, pollIntervalMs: 5, maxPollErrors: 3
      });
      expect(result.status).toBe('approved');
    });
  });

  describe('null user handling', () => {
    test('returns null decided_by when user field is missing', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              incident_id: 'INC-2026-TEST1',
              action_id: 'ACT-2026-AAAAA',
              value: 'approve',
              '@timestamp': '2026-02-17T14:24:15Z'
            }
          }]
        }
      });

      const result = await pollForApproval('INC-2026-TEST1', 'ACT-2026-AAAAA', FAST_OPTIONS);
      expect(result.decided_by).toBeNull();
    });
  });
});
