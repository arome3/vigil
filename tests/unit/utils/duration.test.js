import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock logger ─────────────────────────────────────────────

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

const { parseDuration } = await import('../../../src/utils/duration.js');

// ─── parseDuration ───────────────────────────────────────────

describe('parseDuration', () => {
  it('parses days: "30d" → 2592000000ms', () => {
    assert.equal(parseDuration('30d'), 30 * 24 * 60 * 60 * 1000);
  });

  it('parses days: "14d" → 1209600000ms', () => {
    assert.equal(parseDuration('14d'), 14 * 24 * 60 * 60 * 1000);
  });

  it('parses hours: "1h" → 3600000ms', () => {
    assert.equal(parseDuration('1h'), 3600000);
  });

  it('parses minutes: "60m" → 3600000ms', () => {
    assert.equal(parseDuration('60m'), 3600000);
  });

  it('parses seconds: "300s" → 300000ms', () => {
    assert.equal(parseDuration('300s'), 300000);
  });

  it('edge case: "0d" → returns fallback (zero-length duration)', () => {
    const fallback = 30 * 24 * 60 * 60 * 1000;
    assert.equal(parseDuration('0d'), fallback);
  });

  it('edge case: "0d" with custom fallback → returns custom fallback', () => {
    assert.equal(parseDuration('0d', 5000), 5000);
  });

  it('returns fallback for invalid string "abc"', () => {
    const fallback = 30 * 24 * 60 * 60 * 1000;
    assert.equal(parseDuration('abc'), fallback);
  });

  it('returns fallback for empty string', () => {
    assert.equal(parseDuration(''), 30 * 24 * 60 * 60 * 1000);
  });

  it('returns fallback for null', () => {
    assert.equal(parseDuration(null), 30 * 24 * 60 * 60 * 1000);
  });

  it('returns custom fallback when specified', () => {
    assert.equal(parseDuration('bad', 5000), 5000);
  });

  it('returns custom fallback for null with custom fallback', () => {
    assert.equal(parseDuration(null, 12345), 12345);
  });
});
