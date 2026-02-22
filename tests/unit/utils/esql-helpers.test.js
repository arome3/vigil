import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock logger ─────────────────────────────────────────────

const mockWarn = mock.fn();

mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {},
      warn: mockWarn,
      error: () => {},
      debug: () => {}
    })
  }
});

const { buildColIndex, requireColIndex } =
  await import('../../../src/utils/esql-helpers.js');

// ─── Helpers ─────────────────────────────────────────────────

const sampleColumns = [
  { name: 'total' },
  { name: 'correct' },
  { name: 'tp_count' }
];

// ─── buildColIndex ───────────────────────────────────────────

describe('buildColIndex', () => {
  it('maps column names to indices', () => {
    const idx = buildColIndex(sampleColumns, [], 'test');
    assert.equal(idx.total, 0);
    assert.equal(idx.correct, 1);
    assert.equal(idx.tp_count, 2);
  });

  it('warns on missing expected columns', () => {
    mockWarn.mock.resetCalls();
    buildColIndex(sampleColumns, ['total', 'missing_col'], 'test-tool');
    const calls = mockWarn.mock.calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].arguments[0].includes('missing_col'));
    assert.ok(calls[0].arguments[0].includes('test-tool'));
  });

  it('does not warn when all expected columns present', () => {
    mockWarn.mock.resetCalls();
    buildColIndex(sampleColumns, ['total', 'correct'], 'test-tool');
    assert.equal(mockWarn.mock.calls.length, 0);
  });
});

// ─── requireColIndex ─────────────────────────────────────────

describe('requireColIndex', () => {
  it('returns correct index mapping when all required present', () => {
    const idx = requireColIndex(sampleColumns, ['total', 'correct'], [], 'test');
    assert.equal(idx.total, 0);
    assert.equal(idx.correct, 1);
  });

  it('throws when a required column is missing', () => {
    assert.throws(
      () => requireColIndex(sampleColumns, ['total', 'nonexistent'], [], 'my-tool'),
      (err) => {
        assert.ok(err.message.includes('nonexistent'));
        assert.ok(err.message.includes('my-tool'));
        return true;
      }
    );
  });

  it('throws listing all missing required columns', () => {
    assert.throws(
      () => requireColIndex(sampleColumns, ['foo', 'bar'], [], 'my-tool'),
      (err) => {
        assert.ok(err.message.includes('foo'));
        assert.ok(err.message.includes('bar'));
        return true;
      }
    );
  });

  it('warns on missing optional columns but does not throw', () => {
    mockWarn.mock.resetCalls();
    const idx = requireColIndex(sampleColumns, ['total'], ['missing_opt'], 'test');
    assert.equal(idx.total, 0);
    assert.equal(mockWarn.mock.calls.length, 1);
    assert.ok(mockWarn.mock.calls[0].arguments[0].includes('missing_opt'));
  });

  it('does not warn when optional columns present', () => {
    mockWarn.mock.resetCalls();
    requireColIndex(sampleColumns, ['total'], ['correct'], 'test');
    assert.equal(mockWarn.mock.calls.length, 0);
  });
});
