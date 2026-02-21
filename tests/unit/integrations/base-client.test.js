import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock setup ─────────────────────────────────────────────

const mockAxios = mock.fn();

mock.module('axios', {
  defaultExport: mockAxios
});

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

// Mock circuit-breaker to isolate base-client tests
const mockExecBreaker = mock.fn(async (_name, fn) => fn());

mock.module(import.meta.resolve('../../../src/integrations/circuit-breaker.js'), {
  namedExports: {
    execBreaker: mockExecBreaker
  }
});

// ─── Import module under test ───────────────────────────────

const { IntegrationError, sleep, httpRequest, withRetry, withBreaker } =
  await import('../../../src/integrations/base-client.js');

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/base-client', () => {
  beforeEach(() => {
    mockAxios.mock.resetCalls();
    mockExecBreaker.mock.resetCalls();
    mockExecBreaker.mock.mockImplementation(async (_name, fn) => fn());
  });

  // ── IntegrationError ───────────────────────────────────

  describe('IntegrationError', () => {
    it('sets name, integration, statusCode, and retryable', () => {
      const err = new IntegrationError('test error', {
        integration: 'slack',
        statusCode: 429,
        retryable: true
      });

      assert.equal(err.name, 'IntegrationError');
      assert.equal(err.message, 'test error');
      assert.equal(err.integration, 'slack');
      assert.equal(err.statusCode, 429);
      assert.equal(err.retryable, true);
      assert.ok(err instanceof Error);
    });

    it('defaults retryable to false', () => {
      const err = new IntegrationError('test');
      assert.equal(err.retryable, false);
    });
  });

  // ── sleep ──────────────────────────────────────────────

  describe('sleep', () => {
    it('resolves after delay', async () => {
      const start = Date.now();
      await sleep(10);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 8, `Expected >=8ms, got ${elapsed}ms`);
    });
  });

  // ── httpRequest ────────────────────────────────────────

  describe('httpRequest', () => {
    it('returns status, data, and headers on success', async () => {
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { ok: true },
        headers: { 'content-type': 'application/json' }
      }));

      const result = await httpRequest({ method: 'GET', url: 'https://example.com' });

      assert.equal(result.status, 200);
      assert.deepEqual(result.data, { ok: true });
      assert.equal(result.headers['content-type'], 'application/json');
    });

    it('throws retryable error with retryAfter on 429', async () => {
      mockAxios.mock.mockImplementation(async () => {
        const err = new Error('rate limited');
        err.response = { status: 429, headers: { 'retry-after': '5' } };
        throw err;
      });

      await assert.rejects(
        () => httpRequest({ method: 'GET', url: 'https://example.com' }),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.equal(err.retryable, true);
          assert.equal(err.statusCode, 429);
          assert.equal(err.retryAfter, 5);
          return true;
        }
      );
    });

    it('throws retryable error on 500-504', async () => {
      for (const status of [500, 502, 503, 504]) {
        mockAxios.mock.resetCalls();
        mockAxios.mock.mockImplementation(async () => {
          const err = new Error('server error');
          err.response = { status, headers: {} };
          throw err;
        });

        await assert.rejects(
          () => httpRequest({ method: 'GET', url: 'https://example.com' }),
          (err) => {
            assert.equal(err.retryable, true, `Status ${status} should be retryable`);
            assert.equal(err.statusCode, status);
            return true;
          }
        );
      }
    });

    it('throws non-retryable error on 401/404', async () => {
      for (const status of [401, 404]) {
        mockAxios.mock.resetCalls();
        mockAxios.mock.mockImplementation(async () => {
          const err = new Error('client error');
          err.response = { status, headers: {} };
          throw err;
        });

        await assert.rejects(
          () => httpRequest({ method: 'GET', url: 'https://example.com' }),
          (err) => {
            assert.equal(err.retryable, false, `Status ${status} should not be retryable`);
            return true;
          }
        );
      }
    });

    it('throws retryable error on ECONNRESET/ETIMEDOUT', async () => {
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']) {
        mockAxios.mock.resetCalls();
        mockAxios.mock.mockImplementation(async () => {
          const err = new Error('network error');
          err.code = code;
          throw err;
        });

        await assert.rejects(
          () => httpRequest({ method: 'GET', url: 'https://example.com' }),
          (err) => {
            assert.equal(err.retryable, true, `${code} should be retryable`);
            assert.ok(err.message.includes(code));
            return true;
          }
        );
      }
    });

    it('throws non-retryable error on generic error', async () => {
      mockAxios.mock.mockImplementation(async () => {
        throw new Error('something weird');
      });

      await assert.rejects(
        () => httpRequest({ method: 'GET', url: 'https://example.com' }),
        (err) => {
          assert.equal(err.retryable, false);
          assert.ok(err.message.includes('something weird'));
          return true;
        }
      );
    });
  });

  // ── withRetry ──────────────────────────────────────────

  describe('withRetry', () => {
    it('returns result on first success', async () => {
      const fn = mock.fn(async () => 'ok');
      const result = await withRetry(fn, { maxAttempts: 3 });

      assert.equal(result, 'ok');
      assert.equal(fn.mock.callCount(), 1);
    });

    it('retries on retryable error and succeeds', async () => {
      let callCount = 0;
      const fn = mock.fn(async () => {
        callCount++;
        if (callCount < 3) {
          const err = new IntegrationError('fail', { retryable: true });
          err.retryAfter = 0;
          throw err;
        }
        return 'recovered';
      });

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
      assert.equal(result, 'recovered');
      assert.equal(fn.mock.callCount(), 3);
    });

    it('throws immediately on non-retryable error', async () => {
      const fn = mock.fn(async () => {
        throw new IntegrationError('bad', { retryable: false });
      });

      await assert.rejects(
        () => withRetry(fn, { maxAttempts: 3 }),
        (err) => {
          assert.equal(err.message, 'bad');
          return true;
        }
      );

      assert.equal(fn.mock.callCount(), 1);
    });

    it('exhausts maxAttempts and throws final error', async () => {
      const fn = mock.fn(async () => {
        const err = new IntegrationError('fail', { retryable: true });
        err.retryAfter = 0;
        throw err;
      });

      await assert.rejects(
        () => withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 }),
        (err) => {
          assert.equal(err.message, 'fail');
          return true;
        }
      );

      assert.equal(fn.mock.callCount(), 2);
    });

    it('respects retryAfter on error', async () => {
      let callCount = 0;
      const fn = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          const err = new IntegrationError('rate limited', { retryable: true });
          err.retryAfter = 0; // 0s for test speed
          throw err;
        }
        return 'ok';
      });

      const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 });
      assert.equal(result, 'ok');
    });

    it('tags integration on error when missing', async () => {
      const fn = mock.fn(async () => {
        throw new IntegrationError('fail', { retryable: false });
      });

      await assert.rejects(
        () => withRetry(fn, { maxAttempts: 1, integration: 'test-svc' }),
        (err) => {
          assert.equal(err.integration, 'test-svc');
          return true;
        }
      );
    });

    it('does not overwrite existing integration on error', async () => {
      const fn = mock.fn(async () => {
        throw new IntegrationError('fail', { integration: 'original', retryable: false });
      });

      await assert.rejects(
        () => withRetry(fn, { maxAttempts: 1, integration: 'override' }),
        (err) => {
          assert.equal(err.integration, 'original');
          return true;
        }
      );
    });

    it('maxAttempts=1 throws immediately', async () => {
      const fn = mock.fn(async () => {
        throw new IntegrationError('fail', { retryable: true });
      });

      await assert.rejects(
        () => withRetry(fn, { maxAttempts: 1 }),
        (err) => {
          assert.equal(err.message, 'fail');
          return true;
        }
      );

      assert.equal(fn.mock.callCount(), 1);
    });
  });

  // ── withBreaker ────────────────────────────────────────

  describe('withBreaker', () => {
    it('delegates to execBreaker + withRetry', async () => {
      const fn = mock.fn(async () => 'result');

      const result = await withBreaker('test-svc', fn);

      assert.equal(result, 'result');
      assert.equal(mockExecBreaker.mock.callCount(), 1);
      const args = mockExecBreaker.mock.calls[0].arguments;
      assert.equal(args[0], 'test-svc');
    });
  });
});
