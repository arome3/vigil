import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock logger before importing the module under test
mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    })
  }
});

const { diffSeconds, computeTimingMetrics } = await import(
  '../../../src/agents/coordinator/timing.js'
);

// ---------------------------------------------------------------------------
// diffSeconds
// ---------------------------------------------------------------------------

describe('diffSeconds', () => {
  it('returns correct difference in seconds', () => {
    const start = '2026-02-20T10:00:00.000Z';
    const end   = '2026-02-20T10:05:00.000Z';
    assert.equal(diffSeconds(start, end), 300);
  });

  it('returns null when start is null', () => {
    assert.equal(diffSeconds(null, '2026-02-20T10:05:00.000Z'), null);
  });

  it('returns null when end is null', () => {
    assert.equal(diffSeconds('2026-02-20T10:00:00.000Z', null), null);
  });

  it('returns null for invalid timestamps', () => {
    assert.equal(diffSeconds('not-a-date', 'also-not-a-date'), null);
  });
});

// ---------------------------------------------------------------------------
// computeTimingMetrics
// ---------------------------------------------------------------------------

describe('computeTimingMetrics', () => {
  it('computes TTD from alert_timestamp to detected', () => {
    const doc = {
      incident_id: 'INC-2026-TEST1',
      alert_timestamp: '2026-02-20T10:00:00.000Z',
      _state_timestamps: { detected: '2026-02-20T10:00:30.000Z' }
    };

    const m = computeTimingMetrics(doc);
    assert.equal(m.ttd_seconds, 30);
  });

  it('computes TTI from investigating to planning (fallback path)', () => {
    const doc = {
      incident_id: 'INC-2026-TEST2',
      _state_timestamps: {
        investigating: '2026-02-20T10:01:00.000Z',
        planning:      '2026-02-20T10:03:00.000Z'
      }
    };

    const m = computeTimingMetrics(doc);
    assert.equal(m.tti_seconds, 120);
  });

  it('computes TTR from executing to verifying', () => {
    const doc = {
      incident_id: 'INC-2026-TEST3',
      _state_timestamps: {
        executing: '2026-02-20T10:05:00.000Z',
        verifying: '2026-02-20T10:06:30.000Z'
      }
    };

    const m = computeTimingMetrics(doc);
    assert.equal(m.ttr_seconds, 90);
  });

  it('computes TTV from verifying to resolved', () => {
    const doc = {
      incident_id: 'INC-2026-TEST4',
      _state_timestamps: {
        verifying: '2026-02-20T10:06:30.000Z',
        resolved:  '2026-02-20T10:07:00.000Z'
      }
    };

    const m = computeTimingMetrics(doc);
    assert.equal(m.ttv_seconds, 30);
  });

  it('computes total_duration from created_at to resolved_at', () => {
    const doc = {
      incident_id: 'INC-2026-TEST5',
      created_at:  '2026-02-20T10:00:00.000Z',
      resolved_at: '2026-02-20T10:10:00.000Z',
      _state_timestamps: {}
    };

    const m = computeTimingMetrics(doc);
    assert.equal(m.total_duration_seconds, 600);
  });

  it('returns null for missing timestamps', () => {
    const doc = {
      incident_id: 'INC-2026-TEST6',
      _state_timestamps: {}
    };

    const m = computeTimingMetrics(doc);
    assert.equal(m.ttd_seconds, null);
    assert.equal(m.tti_seconds, null);
    assert.equal(m.ttr_seconds, null);
    assert.equal(m.ttv_seconds, null);
    assert.equal(m.total_duration_seconds, null);
  });
});
