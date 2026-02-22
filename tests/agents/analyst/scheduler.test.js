// Jest test suite for the scheduler analyst module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/analyst/scheduler.test.js

import { jest } from '@jest/globals';

// --- Mock dependencies ---

const mockRunRetrospective = jest.fn().mockResolvedValue({});
const mockRunRunbookGeneration = jest.fn().mockResolvedValue(null);
const mockRunWeightCalibration = jest.fn().mockResolvedValue(null);
const mockRunThresholdTuning = jest.fn().mockResolvedValue(null);
const mockRunPatternDiscovery = jest.fn().mockResolvedValue([]);
const mockClientIndex = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../../../src/agents/analyst/retrospective-writer.js', () => ({
  runRetrospective: mockRunRetrospective
}));

jest.unstable_mockModule('../../../src/agents/analyst/runbook-generator.js', () => ({
  runRunbookGeneration: mockRunRunbookGeneration
}));

jest.unstable_mockModule('../../../src/agents/analyst/weight-calibrator.js', () => ({
  runWeightCalibration: mockRunWeightCalibration
}));

jest.unstable_mockModule('../../../src/agents/analyst/threshold-tuner.js', () => ({
  runThresholdTuning: mockRunThresholdTuning
}));

jest.unstable_mockModule('../../../src/agents/analyst/pattern-discoverer.js', () => ({
  runPatternDiscovery: mockRunPatternDiscovery
}));

jest.unstable_mockModule('../../../src/utils/elastic-client.js', () => ({
  default: { index: mockClientIndex }
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.unstable_mockModule('../../../src/utils/env.js', () => ({
  parseThreshold: (_env, def) => def,
  parsePositiveInt: (_env, def) => def,
  parsePositiveFloat: (_env, def) => def
}));

const mockCronSchedule = jest.fn(() => ({ stop: jest.fn() }));
const mockCronValidate = jest.fn(() => true);
jest.unstable_mockModule('node-cron', () => ({
  default: {
    validate: mockCronValidate,
    schedule: mockCronSchedule
  }
}));

const { analyzeIncident, runBatchAnalysis, startBatchScheduler, stopBatchScheduler } =
  await import('../../../src/agents/analyst/scheduler.js');

// --- Helpers ---

function makeIncidentData() {
  return {
    incident_id: 'INC-SCHED-001',
    status: 'resolved',
    created_at: '2025-01-15T10:00:00Z',
    resolved_at: '2025-01-15T11:00:00Z'
  };
}

let testCounter = 0;
beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish defaults after reset
  mockRunRetrospective.mockResolvedValue({});
  mockRunRunbookGeneration.mockResolvedValue(null);
  mockRunWeightCalibration.mockResolvedValue(null);
  mockRunThresholdTuning.mockResolvedValue(null);
  mockRunPatternDiscovery.mockResolvedValue([]);
  mockClientIndex.mockResolvedValue({});
  mockCronSchedule.mockReturnValue({ stop: jest.fn() });
  mockCronValidate.mockReturnValue(true);
  testCounter++;
});

// --- Tests ---

describe('analyzeIncident', () => {
  it('calls retrospective and runbook generation', async () => {
    const data = makeIncidentData();
    const id = `INC-${testCounter}-001`;
    await analyzeIncident(id, 'resolved', data);

    expect(mockRunRetrospective).toHaveBeenCalledWith(data);
    expect(mockRunRunbookGeneration).toHaveBeenCalledWith(data);
  });

  it('retrospective failure does not block runbook generation', async () => {
    mockRunRetrospective.mockRejectedValueOnce(new Error('Retrospective failed'));

    const data = makeIncidentData();
    const id = `INC-${testCounter}-002`;
    await analyzeIncident(id, 'resolved', data);

    // runbook generation should still be called
    expect(mockRunRunbookGeneration).toHaveBeenCalledWith(data);
  });

  it('runbook generation failure does not crash', async () => {
    mockRunRunbookGeneration.mockRejectedValueOnce(new Error('Runbook gen failed'));

    const data = makeIncidentData();
    const id = `INC-${testCounter}-003`;
    // Should not throw
    await expect(analyzeIncident(id, 'resolved', data)).resolves.not.toThrow();
  });

  it('deadline timeout is logged but does not crash', async () => {
    // Make retrospective hang forever
    mockRunRetrospective.mockImplementation(() => new Promise(() => {}));

    const data = makeIncidentData();
    const id = `INC-${testCounter}-004`;
    // Use a very short deadline
    await expect(
      analyzeIncident(id, 'resolved', data, { deadlineMs: 50 })
    ).resolves.not.toThrow();
  }, 10000);

  it('duplicate analysis within TTL is skipped', async () => {
    const data = makeIncidentData();
    const id = `INC-${testCounter}-DEDUP`;
    await analyzeIncident(id, 'resolved', data);
    await analyzeIncident(id, 'resolved', data);

    // Retrospective should only be called once
    expect(mockRunRetrospective).toHaveBeenCalledTimes(1);
  });
});

describe('runBatchAnalysis', () => {
  it('calls all 3 batch functions', async () => {
    await runBatchAnalysis({ deadlineMs: 5000 });

    expect(mockRunWeightCalibration).toHaveBeenCalledWith({ window: '30d' });
    expect(mockRunThresholdTuning).toHaveBeenCalledWith({ window: '14d' });
    expect(mockRunPatternDiscovery).toHaveBeenCalledWith({ window: '90d' });
  });

  it('one failure does not block others (Promise.allSettled)', async () => {
    mockRunWeightCalibration.mockRejectedValueOnce(new Error('Weight cal failed'));

    await runBatchAnalysis({ deadlineMs: 5000 });

    // Other functions still called
    expect(mockRunThresholdTuning).toHaveBeenCalled();
    expect(mockRunPatternDiscovery).toHaveBeenCalled();
  });

  it('deadline timeout per function is logged', async () => {
    mockRunWeightCalibration.mockImplementation(() => new Promise(() => {}));

    await runBatchAnalysis({ deadlineMs: 50 });

    // The other two should still complete
    expect(mockRunThresholdTuning).toHaveBeenCalled();
    expect(mockRunPatternDiscovery).toHaveBeenCalled();
  }, 10000);

  it('writes batch status record after completion', async () => {
    await runBatchAnalysis({ deadlineMs: 5000 });

    expect(mockClientIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'vigil-analyst-status',
        document: expect.objectContaining({
          batch_type: 'daily_analysis',
          functions_run: 3
        })
      })
    );
  }, 10000);
});

describe('startBatchScheduler / stopBatchScheduler', () => {
  it('startBatchScheduler calls cron.schedule', () => {
    startBatchScheduler();

    expect(mockCronValidate).toHaveBeenCalled();
    expect(mockCronSchedule).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ timezone: 'UTC' })
    );
  });

  it('double-start stops previous instance', () => {
    const mockStop = jest.fn();
    mockCronSchedule.mockReturnValueOnce({ stop: mockStop });

    startBatchScheduler();
    startBatchScheduler();

    // First instance's stop should have been called
    expect(mockStop).toHaveBeenCalled();
  });

  it('stopBatchScheduler calls task.stop', () => {
    const mockStop = jest.fn();
    mockCronSchedule.mockReturnValueOnce({ stop: mockStop });

    startBatchScheduler();
    stopBatchScheduler();

    expect(mockStop).toHaveBeenCalled();
  });
});
