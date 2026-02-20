import { describe, it, beforeEach, afterEach, mock } from 'node:test';
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

const { parseThreshold, parsePositiveInt } =
  await import('../../../src/utils/env.js');

// ─── Helpers ────────────────────────────────────────────────

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

// ─── parseThreshold ─────────────────────────────────────────

describe('parseThreshold', () => {
  it('returns default when env var is unset', () => {
    withEnv('TEST_THRESHOLD', undefined, () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.5);
    });
  });

  it('returns default when env var is empty string', () => {
    withEnv('TEST_THRESHOLD', '', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.5);
    });
  });

  it('parses valid float 0.7', () => {
    withEnv('TEST_THRESHOLD', '0.7', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.7);
    });
  });

  it('returns default for non-numeric "abc"', () => {
    withEnv('TEST_THRESHOLD', 'abc', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.5);
    });
  });

  it('returns default for value > 1', () => {
    withEnv('TEST_THRESHOLD', '1.5', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.5);
    });
  });

  it('returns default for value < 0', () => {
    withEnv('TEST_THRESHOLD', '-0.1', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.5);
    });
  });

  it('accepts exact 0.0', () => {
    withEnv('TEST_THRESHOLD', '0.0', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 0.0);
    });
  });

  it('accepts exact 1.0', () => {
    withEnv('TEST_THRESHOLD', '1.0', () => {
      assert.equal(parseThreshold('TEST_THRESHOLD', 0.5), 1.0);
    });
  });
});

// ─── parsePositiveInt ───────────────────────────────────────

describe('parsePositiveInt', () => {
  it('returns default when env var is unset', () => {
    withEnv('TEST_INT', undefined, () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 3);
    });
  });

  it('returns default when env var is empty string', () => {
    withEnv('TEST_INT', '', () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 3);
    });
  });

  it('parses valid integer 5', () => {
    withEnv('TEST_INT', '5', () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 5);
    });
  });

  it('returns default for non-numeric "abc"', () => {
    withEnv('TEST_INT', 'abc', () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 3);
    });
  });

  it('returns default for zero', () => {
    withEnv('TEST_INT', '0', () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 3);
    });
  });

  it('returns default for negative value', () => {
    withEnv('TEST_INT', '-2', () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 3);
    });
  });

  it('accepts exact 1', () => {
    withEnv('TEST_INT', '1', () => {
      assert.equal(parsePositiveInt('TEST_INT', 3), 1);
    });
  });
});
