import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════
// Mock functions
// ═══════════════════════════════════════════════════════════════

const mockGetIncident = mock.fn();
const mockComputeTimingMetrics = mock.fn();
const mockSendA2AMessage = mock.fn();
const mockCreateEnvelope = mock.fn((_from, _to, _corr, payload) => ({
  message_id: 'msg-test', from_agent: _from, to_agent: _to,
  timestamp: '2026-02-20T10:00:00.000Z', correlation_id: _corr, payload
}));
const mockClientSearch = mock.fn();
const mockClientIndex = mock.fn();

// ═══════════════════════════════════════════════════════════════
// Register mocks before importing module under test
// ═══════════════════════════════════════════════════════════════

mock.module(import.meta.resolve('../../../src/state-machine/transitions.js'), {
  namedExports: { getIncident: mockGetIncident }
});

mock.module(import.meta.resolve('../../../src/agents/coordinator/timing.js'), {
  namedExports: { computeTimingMetrics: mockComputeTimingMetrics }
});

mock.module(import.meta.resolve('../../../src/a2a/router.js'), {
  namedExports: { sendA2AMessage: mockSendA2AMessage }
});

mock.module(import.meta.resolve('../../../src/a2a/message-envelope.js'), {
  namedExports: { createEnvelope: mockCreateEnvelope }
});

mock.module(import.meta.resolve('../../../src/utils/elastic-client.js'), {
  defaultExport: {
    search: mockClientSearch,
    index: mockClientIndex
  }
});

mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}
    })
  }
});

// ═══════════════════════════════════════════════════════════════
// Import module under test
// ═══════════════════════════════════════════════════════════════

const { generateIncidentReport, triggerReportingWorkflow } =
  await import('../../../src/agents/coordinator/reporting.js');

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

const FIXED_METRICS = {
  ttd_seconds: 30, tti_seconds: 120, ttr_seconds: 90,
  ttv_seconds: 30, total_duration_seconds: 600
};

function makeIncidentDoc(overrides = {}) {
  return {
    incident_id: 'INC-2026-AAAAA',
    status: 'resolved',
    incident_type: 'security',
    severity: 'high',
    investigation_summary: 'Credential theft via phishing',
    resolution_type: 'auto_resolved',
    affected_services: ['web-1'],
    reflection_count: 0,
    ...overrides
  };
}

function makeActionHit(agentName, idx) {
  return {
    _source: {
      action_id: `ACT-${idx}`,
      agent_name: agentName,
      action_type: 'isolate_host',
      status: 'success',
      '@timestamp': `2026-02-20T10:0${idx}:00.000Z`
    },
    sort: [`2026-02-20T10:0${idx}:00.000Z`, `act-${idx}`]
  };
}

function resetAllMocks() {
  for (const fn of [
    mockGetIncident, mockComputeTimingMetrics,
    mockSendA2AMessage, mockCreateEnvelope,
    mockClientSearch, mockClientIndex
  ]) {
    fn.mock.resetCalls();
    fn.mock.restore();
  }
}

function setupDefaultMocks() {
  mockGetIncident.mock.mockImplementation(async () => ({
    doc: makeIncidentDoc(), _seq_no: 1, _primary_term: 1
  }));
  mockComputeTimingMetrics.mock.mockImplementation(() => FIXED_METRICS);
  mockClientSearch.mock.mockImplementation(async () => ({ hits: { hits: [] } }));
  mockClientIndex.mock.mockImplementation(async () => ({ result: 'created' }));
  mockSendA2AMessage.mock.mockImplementation(async () => ({ status: 'sent' }));
}

// ═══════════════════════════════════════════════════════════════
// Tests: generateIncidentReport
// ═══════════════════════════════════════════════════════════════

describe('generateIncidentReport', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  it('builds report with correct schema from incident doc', async () => {
    const report = await generateIncidentReport('INC-2026-AAAAA');

    assert.equal(report.report_id, 'RPT-INC-2026-AAAAA');
    assert.equal(report.incident_id, 'INC-2026-AAAAA');
    assert.equal(report.summary.incident_type, 'security');
    assert.equal(report.summary.severity, 'high');
    assert.equal(report.summary.resolution_type, 'auto_resolved');
    assert.equal(report.summary.reflection_count, 0);
    assert.deepEqual(report.timing_metrics, FIXED_METRICS);
    assert.ok(Array.isArray(report.actions_taken));
    assert.ok(Array.isArray(report.affected_services));
    assert.ok(Array.isArray(report.agents_involved));
    assert.ok(report.generated_at);
  });

  it('fetches actions with search_after pagination', async () => {
    let callCount = 0;
    mockClientSearch.mock.mockImplementation(async (params) => {
      callCount++;
      if (callCount === 1) {
        return {
          hits: { hits: [makeActionHit('vigil-executor', 1), makeActionHit('vigil-executor', 2)] }
        };
      }
      if (callCount === 2) {
        return {
          hits: { hits: [makeActionHit('vigil-verifier', 3)] }
        };
      }
      return { hits: { hits: [] } };
    });

    const report = await generateIncidentReport('INC-2026-AAAAA');

    assert.equal(report.actions_taken.length, 3);
    // Verify search_after was used on second call
    assert.equal(callCount, 3); // 2 pages with data + 1 empty page
    const secondCall = mockClientSearch.mock.calls[1];
    assert.ok(secondCall.arguments[0].search_after, 'second call should use search_after');
  });

  it('derives unique agents from actions', async () => {
    mockClientSearch.mock.mockImplementation(async (params) => {
      if (params.search_after) return { hits: { hits: [] } };
      return {
        hits: {
          hits: [
            makeActionHit('vigil-executor', 1),
            makeActionHit('vigil-verifier', 2),
            makeActionHit('vigil-executor', 3) // duplicate agent
          ]
        }
      };
    });

    const report = await generateIncidentReport('INC-2026-AAAAA');

    assert.equal(report.agents_involved.length, 2);
    assert.ok(report.agents_involved.includes('vigil-executor'));
    assert.ok(report.agents_involved.includes('vigil-verifier'));
  });

  it('returns empty actions on fetch failure (graceful degradation)', async () => {
    mockClientSearch.mock.mockImplementation(async () => {
      throw new Error('search cluster unavailable');
    });

    const report = await generateIncidentReport('INC-2026-AAAAA');

    assert.deepEqual(report.actions_taken, []);
    assert.deepEqual(report.agents_involved, []);
  });

  it('indexes report to vigil-reports', async () => {
    await generateIncidentReport('INC-2026-AAAAA');

    const reportIndexCalls = mockClientIndex.mock.calls.filter(
      c => c.arguments[0].index === 'vigil-reports'
    );
    assert.equal(reportIndexCalls.length, 1);
    assert.equal(reportIndexCalls[0].arguments[0].id, 'RPT-INC-2026-AAAAA');
  });

  it('throws when report indexing fails', async () => {
    mockClientIndex.mock.mockImplementation(async (params) => {
      if (params.index === 'vigil-reports') throw new Error('index write failed');
      return { result: 'created' };
    });

    await assert.rejects(
      () => generateIncidentReport('INC-2026-AAAAA'),
      { message: 'index write failed' }
    );
  });

  it('validates report object before indexing', async () => {
    // Force resolution_type to null to trigger validation failure
    mockGetIncident.mock.mockImplementation(async () => ({
      doc: makeIncidentDoc({ resolution_type: null }),
      _seq_no: 1, _primary_term: 1
    }));

    await assert.rejects(
      () => generateIncidentReport('INC-2026-AAAAA'),
      (err) => {
        assert.match(err.message, /Report validation failed/);
        assert.match(err.message, /resolution_type/);
        return true;
      }
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: triggerReportingWorkflow
// ═══════════════════════════════════════════════════════════════

describe('triggerReportingWorkflow', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  const makeReport = () => ({
    report_id: 'RPT-INC-2026-AAAAA',
    incident_id: 'INC-2026-AAAAA',
    summary: { severity: 'high', resolution_type: 'auto_resolved' }
  });

  it('sends envelope to vigil-wf-reporting', async () => {
    await triggerReportingWorkflow('INC-2026-AAAAA', makeReport());

    assert.equal(mockSendA2AMessage.mock.callCount(), 1);
    assert.equal(mockSendA2AMessage.mock.calls[0].arguments[0], 'vigil-wf-reporting');
  });

  it('does not throw when workflow trigger fails', async () => {
    mockSendA2AMessage.mock.mockImplementation(async () => {
      throw new Error('workflow service down');
    });

    await assert.doesNotReject(() =>
      triggerReportingWorkflow('INC-2026-AAAAA', makeReport())
    );
  });

  it('builds correct payload shape', async () => {
    await triggerReportingWorkflow('INC-2026-AAAAA', makeReport());

    const envelopeCall = mockCreateEnvelope.mock.calls[0];
    const payload = envelopeCall.arguments[3];
    assert.equal(payload.task, 'generate_report');
    assert.equal(payload.incident_id, 'INC-2026-AAAAA');
    assert.equal(payload.report_id, 'RPT-INC-2026-AAAAA');
    assert.equal(payload.severity, 'high');
    assert.equal(payload.resolution_type, 'auto_resolved');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tests: telemetry
// ═══════════════════════════════════════════════════════════════

describe('telemetry', () => {
  beforeEach(() => {
    resetAllMocks();
    setupDefaultMocks();
  });

  it('indexes generation telemetry on success', async () => {
    await generateIncidentReport('INC-2026-AAAAA');

    const telemetryCalls = mockClientIndex.mock.calls.filter(
      c => c.arguments[0].index === 'vigil-watcher-telemetry'
    );
    assert.ok(telemetryCalls.length >= 1);
    const doc = telemetryCalls[0].arguments[0].document;
    assert.equal(doc.component, 'coordinator-reporting');
    assert.equal(doc.incident_id, 'INC-2026-AAAAA');
    assert.equal(doc.report_id, 'RPT-INC-2026-AAAAA');
    assert.ok(typeof doc.generation_duration_ms === 'number');
  });

  it('telemetry failure does not affect report return', async () => {
    let indexCallCount = 0;
    mockClientIndex.mock.mockImplementation(async (params) => {
      indexCallCount++;
      // First call is the report index, let it succeed
      if (params.index === 'vigil-reports') return { result: 'created' };
      // Telemetry index fails
      if (params.index === 'vigil-watcher-telemetry') throw new Error('telemetry write failed');
      return { result: 'created' };
    });

    const report = await generateIncidentReport('INC-2026-AAAAA');

    assert.ok(report, 'report should still be returned');
    assert.equal(report.report_id, 'RPT-INC-2026-AAAAA');
  });
});
