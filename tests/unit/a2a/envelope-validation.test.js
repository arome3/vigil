import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEnvelope,
  validateEnvelope,
  EnvelopeValidationError
} from '../../../src/a2a/message-envelope.js';

// ─── createEnvelope ─────────────────────────────────────────

describe('createEnvelope', () => {
  it('produces all required fields', () => {
    const env = createEnvelope('agent-a', 'agent-b', 'corr-1', { task: 'test' });
    assert.equal(typeof env.message_id, 'string');
    assert.equal(env.from_agent, 'agent-a');
    assert.equal(env.to_agent, 'agent-b');
    assert.equal(env.correlation_id, 'corr-1');
    assert.deepEqual(env.payload, { task: 'test' });
    assert.equal(typeof env.timestamp, 'string');
  });

  it('generates unique message_id per call', () => {
    const a = createEnvelope('a', 'b', 'c', { x: 1 });
    const b = createEnvelope('a', 'b', 'c', { x: 1 });
    assert.notEqual(a.message_id, b.message_id);
  });

  it('generates valid ISO 8601 timestamp', () => {
    const env = createEnvelope('a', 'b', 'c', { x: 1 });
    // ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ
    const parsed = Date.parse(env.timestamp);
    assert.equal(isNaN(parsed), false, 'timestamp should be a valid date');
  });
});

// ─── validateEnvelope ───────────────────────────────────────

describe('validateEnvelope', () => {
  const validEnvelope = {
    message_id: 'msg-abc-123',
    from_agent: 'vigil-coordinator',
    to_agent: 'vigil-triage',
    timestamp: new Date().toISOString(),
    correlation_id: 'corr-001',
    payload: { task: 'enrich_and_score' }
  };

  it('accepts a valid envelope', () => {
    assert.doesNotThrow(() => validateEnvelope(validEnvelope));
    assert.equal(validateEnvelope(validEnvelope), true);
  });

  it('rejects null', () => {
    assert.throws(() => validateEnvelope(null), (err) => {
      assert.equal(err.name, 'EnvelopeValidationError');
      return true;
    });
  });

  it('rejects missing message_id', () => {
    const bad = { ...validEnvelope, message_id: undefined };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('message_id')));
      return true;
    });
  });

  it('rejects missing from_agent', () => {
    const bad = { ...validEnvelope, from_agent: undefined };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('from_agent')));
      return true;
    });
  });

  it('rejects missing correlation_id', () => {
    const bad = { ...validEnvelope, correlation_id: undefined };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('correlation_id')));
      return true;
    });
  });

  it('rejects missing payload', () => {
    const bad = { ...validEnvelope, payload: undefined };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('payload')));
      return true;
    });
  });

  it('rejects non-object payload', () => {
    const bad = { ...validEnvelope, payload: 'not-an-object' };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('payload')));
      return true;
    });
  });

  // ── Array payload (Bug 3 fix) ──

  it('rejects array payload', () => {
    const bad = { ...validEnvelope, payload: [{ task: 'test' }] };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('payload')));
      return true;
    });
  });

  // ── Missing to_agent (F3) ──

  it('rejects missing to_agent', () => {
    const bad = { ...validEnvelope, to_agent: undefined };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('to_agent')));
      return true;
    });
  });

  // ── Empty string (falsy string branch) ──

  it('rejects empty string message_id', () => {
    const bad = { ...validEnvelope, message_id: '' };
    assert.throws(() => validateEnvelope(bad), (err) => {
      assert.ok(err.errors.some(e => e.includes('message_id')));
      return true;
    });
  });

  // ── Multiple missing fields at once ──

  it('accumulates errors for all 6 missing fields', () => {
    assert.throws(() => validateEnvelope({}), (err) => {
      assert.equal(err.name, 'EnvelopeValidationError');
      assert.equal(err.errors.length, 6);
      assert.ok(err.errors.some(e => e.includes('message_id')));
      assert.ok(err.errors.some(e => e.includes('from_agent')));
      assert.ok(err.errors.some(e => e.includes('to_agent')));
      assert.ok(err.errors.some(e => e.includes('timestamp')));
      assert.ok(err.errors.some(e => e.includes('correlation_id')));
      assert.ok(err.errors.some(e => e.includes('payload')));
      return true;
    });
  });
});

// ─── EnvelopeValidationError shape (T3) ─────────────────────

describe('EnvelopeValidationError', () => {
  it('has name and errors properties', () => {
    const err = new EnvelopeValidationError(['field missing']);
    assert.equal(err.name, 'EnvelopeValidationError');
    assert.deepEqual(err.errors, ['field missing']);
    assert.ok(err.message.includes('field missing'));
  });

  it('is an instance of Error', () => {
    const err = new EnvelopeValidationError([]);
    assert.ok(err instanceof Error);
  });
});
