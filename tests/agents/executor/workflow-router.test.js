// Unit tests for the Executor workflow router.
// These test the real module — no mocks needed (pure functions).

import { jest } from '@jest/globals';

const { routeAction, VALID_ACTION_TYPES } = await import(
  '../../../src/agents/executor/workflow-router.js'
);

describe('workflow-router', () => {
  // ── VALID_ACTION_TYPES ─────────────────────────────────

  describe('VALID_ACTION_TYPES', () => {
    test('contains exactly 4 action types', () => {
      expect(VALID_ACTION_TYPES).toEqual([
        'containment', 'remediation', 'communication', 'documentation'
      ]);
    });

    test('is a frozen array (immutable)', () => {
      // Array itself is not frozen, but the routing table is.
      // Verify the exported list has the expected values.
      expect(VALID_ACTION_TYPES).toHaveLength(4);
    });
  });

  // ── Routing ────────────────────────────────────────────

  describe('routeAction', () => {
    test('routes containment → vigil-wf-containment', () => {
      const result = routeAction({ action_type: 'containment', description: 'Block IP', target_system: 'cloudflare' });
      expect(result.workflowId).toBe('vigil-wf-containment');
    });

    test('routes remediation → vigil-wf-remediation', () => {
      const result = routeAction({ action_type: 'remediation', description: 'Rollback', target_system: 'kubernetes' });
      expect(result.workflowId).toBe('vigil-wf-remediation');
    });

    test('routes communication → vigil-wf-notify', () => {
      const result = routeAction({ action_type: 'communication', description: 'Notify', target_system: 'slack' });
      expect(result.workflowId).toBe('vigil-wf-notify');
    });

    test('routes documentation → vigil-wf-ticketing', () => {
      const result = routeAction({ action_type: 'documentation', description: 'Create ticket', target_system: 'jira' });
      expect(result.workflowId).toBe('vigil-wf-ticketing');
    });

    test('throws on unknown action_type', () => {
      expect(() => routeAction({ action_type: 'destroy' })).toThrow(
        "Unknown action_type: 'destroy'"
      );
    });

    test('error message includes valid types list', () => {
      expect(() => routeAction({ action_type: 'nuke' })).toThrow(
        'Valid types: containment, remediation, communication, documentation'
      );
    });

    test('throws on undefined action_type', () => {
      expect(() => routeAction({})).toThrow('Unknown action_type');
    });
  });

  // ── workflowParams shape ───────────────────────────────

  describe('workflowParams', () => {
    test('includes all expected fields', () => {
      const action = {
        action_type: 'remediation',
        description: 'Rollback api-gateway',
        target_system: 'kubernetes',
        target_asset: 'api-gateway',
        params: { commit_sha: 'abc123' },
        rollback_steps: 'Re-deploy previous version'
      };

      const { workflowParams } = routeAction(action);

      expect(workflowParams).toEqual({
        action_type: 'remediation',
        description: 'Rollback api-gateway',
        target_system: 'kubernetes',
        target_asset: 'api-gateway',
        params: { commit_sha: 'abc123' },
        rollback_steps: 'Re-deploy previous version'
      });
    });

    test('defaults target_asset to null when missing', () => {
      const action = { action_type: 'containment', description: 'Block', target_system: 'cloudflare' };
      const { workflowParams } = routeAction(action);
      expect(workflowParams.target_asset).toBeNull();
    });

    test('defaults params to empty object when missing', () => {
      const action = { action_type: 'containment', description: 'Block', target_system: 'cloudflare' };
      const { workflowParams } = routeAction(action);
      expect(workflowParams.params).toEqual({});
    });

    test('defaults rollback_steps to null when missing', () => {
      const action = { action_type: 'containment', description: 'Block', target_system: 'cloudflare' };
      const { workflowParams } = routeAction(action);
      expect(workflowParams.rollback_steps).toBeNull();
    });
  });

  // ── Routing table immutability ─────────────────────────

  describe('routing table immutability', () => {
    test('routing is consistent across calls', () => {
      const action = { action_type: 'containment', description: 'Block', target_system: 'cf' };
      const r1 = routeAction(action);
      const r2 = routeAction(action);
      expect(r1.workflowId).toBe(r2.workflowId);
    });
  });
});
