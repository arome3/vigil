// Integration test: analyst pipeline end-to-end
// Requires: running Elasticsearch instance with vigil indices
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/integration/analyst-pipeline.test.js
//
// Steps:
// 1. Seed vigil-incidents with 5 resolved security incidents
// 2. Call analyzeIncident → verify retrospective + runbook written
// 3. Call runBatchAnalysis → verify weight cal, threshold tune, pattern discovery
// 4. Re-run batch → verify idempotency (no duplicates)
// 5. Clean up: delete seeded test documents

import { jest } from '@jest/globals';

describe.skip('Analyst pipeline integration', () => {
  // Uncomment and configure when running against a real ES cluster:
  //
  // const TEST_INDEX_PREFIX = 'vigil-test-';
  //
  // beforeAll(async () => {
  //   // Seed 5 resolved security incidents with overlapping MITRE techniques
  //   // into vigil-incidents index
  // });
  //
  // afterAll(async () => {
  //   // Delete all documents created during the test
  //   // (match by incident_id prefix or learning_id prefix)
  // });
  //
  // it('analyzeIncident writes retrospective and runbook', async () => {
  //   // Call analyzeIncident with one of the seeded incidents
  //   // Verify vigil-learnings has a retrospective record
  //   // Verify vigil-runbooks has a new runbook
  // });
  //
  // it('runBatchAnalysis writes weight, threshold, and pattern records', async () => {
  //   // Call runBatchAnalysis
  //   // Verify vigil-learnings has weight_calibration record
  //   // Verify vigil-learnings has threshold_tuning record
  //   // Verify vigil-learnings has pattern_discovery record
  // });
  //
  // it('re-run is idempotent (no duplicate records)', async () => {
  //   // Call runBatchAnalysis again
  //   // Count documents — should be same as after first run
  //   // (op_type: 'create' prevents duplicates)
  // });

  it('placeholder', () => {
    // This test suite is a skeleton for future integration testing
    expect(true).toBe(true);
  });
});
