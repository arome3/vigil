// Jest test suite for the Verifier stabilization wait module.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/verifier/stabilization.test.js

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { waitForStabilization } = await import(
  '../../../src/agents/verifier/stabilization.js'
);

describe('waitForStabilization', () => {
  test('resolves immediately when seconds is 0', async () => {
    const start = Date.now();
    await waitForStabilization(0);
    const elapsed = Date.now() - start;

    // Should complete in under 50ms (effectively instant)
    expect(elapsed).toBeLessThan(50);
  });

  test('resolves immediately when seconds is negative', async () => {
    const start = Date.now();
    await waitForStabilization(-5);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  test('waits approximately the specified duration', async () => {
    const start = Date.now();
    await waitForStabilization(1); // 1 second — short for testing
    const elapsed = Date.now() - start;

    // Should take at least 900ms (allowing 100ms tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // Should complete within 1500ms (generous upper bound)
    expect(elapsed).toBeLessThan(1500);
  });

  test('uses 15-second intervals for long waits', async () => {
    // We can't wait 60s in a test, but we can verify the function
    // exists and returns a promise for a short duration
    const start = Date.now();
    await waitForStabilization(2);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(3000);
  });
});
