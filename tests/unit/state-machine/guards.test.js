import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock logger (guards.js imports it at module level) ─────

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

// ─── Import module under test ───────────────────────────────

const { evaluateGuard, GUARD_REGISTRY, reflectionAutoEscalateGuard } =
  await import('../../../src/state-machine/guards.js');

// ─── Helpers ────────────────────────────────────────────────

function createDoc(overrides = {}) {
  return {
    incident_id: 'INC-TEST-001',
    status: 'detected',
    priority_score: 0.87,
    reflection_count: 0,
    ...overrides
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('evaluateGuard', () => {
  it('returns allowed true when no guard registered for pair', () => {
    const result = evaluateGuard(createDoc(), 'detected', 'triaged');
    assert.equal(result.allowed, true);
    assert.equal(result.redirectTo, null);
    assert.equal(result.reason, 'no guard registered');
  });

  it('throws TypeError when incidentDoc is null', () => {
    assert.throws(
      () => evaluateGuard(null, 'detected', 'triaged'),
      { name: 'TypeError', message: 'incidentDoc is required and must be an object' }
    );
  });

  it('throws TypeError when incidentDoc is undefined', () => {
    assert.throws(
      () => evaluateGuard(undefined, 'detected', 'triaged'),
      { name: 'TypeError', message: 'incidentDoc is required and must be an object' }
    );
  });
});

describe('reflection_limit guard', () => {
  it('returns redirectTo escalated when reflection_count >= 3', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 3 }),
      'verifying', 'reflecting',
      { verifierResponse: { passed: false } }
    );
    assert.equal(result.allowed, false);
    assert.equal(result.redirectTo, 'escalated');
  });

  it('returns allowed true when reflection_count < 3', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 2 }),
      'verifying', 'reflecting',
      { verifierResponse: { passed: false } }
    );
    assert.equal(result.allowed, true);
    assert.equal(result.redirectTo, null);
  });
});

describe('approval_required guard', () => {
  it('allows planning -> awaiting_approval when actions require approval', () => {
    const result = evaluateGuard(
      createDoc(),
      'planning', 'awaiting_approval',
      { remediationPlan: { actions: [{ approval_required: true }] } }
    );
    assert.equal(result.allowed, true);
  });

  it('disallows when no actions require approval', () => {
    const result = evaluateGuard(
      createDoc(),
      'planning', 'awaiting_approval',
      { remediationPlan: { actions: [{ approval_required: false }] } }
    );
    assert.equal(result.allowed, false);
  });
});

describe('approval_not_required guard', () => {
  it('allows planning -> executing when no actions require approval', () => {
    const result = evaluateGuard(
      createDoc(),
      'planning', 'executing',
      { remediationPlan: { actions: [{ approval_required: false }] } }
    );
    assert.equal(result.allowed, true);
  });

  it('disallows when actions require approval', () => {
    const result = evaluateGuard(
      createDoc(),
      'planning', 'executing',
      { remediationPlan: { actions: [{ approval_required: true }] } }
    );
    assert.equal(result.allowed, false);
  });
});

describe('suppress_threshold guard', () => {
  it('allows triaged -> suppressed when priority_score < 0.4', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: 0.2 }),
      'triaged', 'suppressed'
    );
    assert.equal(result.allowed, true);
  });

  it('disallows when priority_score >= 0.4', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: 0.5 }),
      'triaged', 'suppressed'
    );
    assert.equal(result.allowed, false);
  });
});

describe('investigate_threshold guard', () => {
  it('allows triaged -> investigating when priority_score >= 0.4', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: 0.5 }),
      'triaged', 'investigating'
    );
    assert.equal(result.allowed, true);
  });

  it('disallows when priority_score < 0.4', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: 0.2 }),
      'triaged', 'investigating'
    );
    assert.equal(result.allowed, false);
  });
});

describe('verifier guards', () => {
  it('allows verifying -> resolved when passed is true', () => {
    const result = evaluateGuard(
      createDoc(),
      'verifying', 'resolved',
      { verifierResponse: { passed: true } }
    );
    assert.equal(result.allowed, true);
  });

  it('disallows verifying -> resolved when passed is false', () => {
    const result = evaluateGuard(
      createDoc(),
      'verifying', 'resolved',
      { verifierResponse: { passed: false } }
    );
    assert.equal(result.allowed, false);
  });

  it('allows verifying -> reflecting when passed is false', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 0 }),
      'verifying', 'reflecting',
      { verifierResponse: { passed: false } }
    );
    assert.equal(result.allowed, true);
  });

  it('disallows verifying -> reflecting when passed is true', () => {
    const result = evaluateGuard(
      createDoc(),
      'verifying', 'reflecting',
      { verifierResponse: { passed: true } }
    );
    assert.equal(result.allowed, false);
  });
});

// ─── Edge-case tests ────────────────────────────────────────

describe('suppress_threshold boundary', () => {
  it('disallows suppress when priority_score === 0.4 (strict <)', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: 0.4 }),
      'triaged', 'suppressed'
    );
    assert.equal(result.allowed, false);
  });

  it('allows investigate when priority_score === 0.4 (uses >=)', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: 0.4 }),
      'triaged', 'investigating'
    );
    assert.equal(result.allowed, true);
  });
});

describe('undefined priority_score handling', () => {
  it('disallows suppress when priority_score is undefined', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: undefined }),
      'triaged', 'suppressed'
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing or invalid/);
  });

  it('disallows investigate when priority_score is undefined', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: undefined }),
      'triaged', 'investigating'
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing or invalid/);
  });

  it('disallows suppress when priority_score is null', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: null }),
      'triaged', 'suppressed'
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing or invalid/);
  });

  it('disallows investigate when priority_score is null', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: null }),
      'triaged', 'investigating'
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing or invalid/);
  });

  it('disallows suppress when priority_score is NaN', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: NaN }),
      'triaged', 'suppressed'
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing or invalid/);
  });

  it('disallows investigate when priority_score is NaN', () => {
    const result = evaluateGuard(
      createDoc({ priority_score: NaN }),
      'triaged', 'investigating'
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing or invalid/);
  });
});

describe('approval guards with missing actions array', () => {
  it('disallows approval_required when plan is empty object', () => {
    const result = evaluateGuard(
      createDoc(), 'planning', 'awaiting_approval',
      { remediationPlan: {} }
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /actions is not an array/);
  });

  it('disallows approval_not_required when plan is empty object', () => {
    const result = evaluateGuard(
      createDoc(), 'planning', 'executing',
      { remediationPlan: {} }
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /actions is not an array/);
  });

  it('disallows approval_required when actions is null', () => {
    const result = evaluateGuard(
      createDoc(), 'planning', 'awaiting_approval',
      { remediationPlan: { actions: null } }
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /actions is not an array/);
  });

  it('disallows approval_required with empty actions array (no actions need approval)', () => {
    const result = evaluateGuard(
      createDoc(), 'planning', 'awaiting_approval',
      { remediationPlan: { actions: [] } }
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no actions require approval/);
  });
});

describe('GUARD_REGISTRY completeness', () => {
  const expectedKeys = [
    'verifying->reflecting',
    'verifying->resolved',
    'planning->awaiting_approval',
    'planning->executing',
    'awaiting_approval->executing',
    'awaiting_approval->escalated',
    'triaged->suppressed',
    'triaged->investigating',
    'reflecting->escalated',
  ];

  it('contains all expected guard keys', () => {
    for (const key of expectedKeys) {
      assert.ok(GUARD_REGISTRY.has(key), `Missing guard key: ${key}`);
    }
  });

  it('has exactly the expected number of guards', () => {
    assert.equal(GUARD_REGISTRY.size, expectedKeys.length);
  });

  it('all registry values are arity-2 functions', () => {
    for (const [key, fn] of GUARD_REGISTRY) {
      assert.equal(typeof fn, 'function', `${key} is not a function`);
      assert.equal(fn.length, 2, `${key} does not accept 2 arguments (has ${fn.length})`);
    }
  });
});

describe('verifier guards with null context', () => {
  it('disallows verifying -> resolved with null context', () => {
    const result = evaluateGuard(createDoc(), 'verifying', 'resolved', null);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing required context/);
  });

  it('disallows verifying -> resolved with empty context', () => {
    const result = evaluateGuard(createDoc(), 'verifying', 'resolved', {});
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing required context/);
  });

  it('disallows verifying -> reflecting with null context', () => {
    const result = evaluateGuard(createDoc(), 'verifying', 'reflecting', null);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /missing required context/);
  });
});

describe('reflecting -> escalated guard', () => {
  it('allows escalation when reflection_count equals limit (3)', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 3 }),
      'reflecting', 'escalated'
    );
    assert.equal(result.allowed, true);
  });

  it('allows escalation when reflection_count exceeds limit (5)', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 5 }),
      'reflecting', 'escalated'
    );
    assert.equal(result.allowed, true);
  });

  it('blocks escalation when reflection_count is within limit (1)', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 1 }),
      'reflecting', 'escalated'
    );
    assert.equal(result.allowed, false);
  });

  it('blocks escalation when reflection_count is 0', () => {
    const result = evaluateGuard(
      createDoc({ reflection_count: 0 }),
      'reflecting', 'escalated'
    );
    assert.equal(result.allowed, false);
  });

  it('is exported as a named function', () => {
    assert.equal(typeof reflectionAutoEscalateGuard, 'function');
    assert.equal(reflectionAutoEscalateGuard.length, 2);
  });
});
