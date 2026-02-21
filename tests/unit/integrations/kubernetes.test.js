import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock setup ─────────────────────────────────────────────

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

// Mock axios (required by base-client which k8s imports)
mock.module('axios', { defaultExport: mock.fn() });

const mockPatch = mock.fn();
const mockRead = mock.fn();
const mockListRS = mock.fn();

const mockMakeApiClient = mock.fn(() => ({
  patchNamespacedDeployment: mockPatch,
  readNamespacedDeployment: mockRead,
  listNamespacedReplicaSet: mockListRS
}));

mock.module('@kubernetes/client-node', {
  namedExports: {
    KubeConfig: class MockKubeConfig {
      loadFromDefault() {}
      setCurrentContext() {}
      makeApiClient = mockMakeApiClient;
    },
    AppsV1Api: class MockAppsV1Api {}
  }
});

// ─── Import module under test ───────────────────────────────

const {
  restartDeployment,
  rollbackDeployment,
  scaleDeployment,
  getDeploymentStatus,
  _resetClient
} = await import('../../../src/integrations/kubernetes.js');

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/kubernetes', () => {
  beforeEach(() => {
    _resetClient();
    mockPatch.mock.resetCalls();
    mockRead.mock.resetCalls();
    mockListRS.mock.resetCalls();
    mockMakeApiClient.mock.resetCalls();
    mockPatch.mock.mockImplementation(async () => ({}));
    mockRead.mock.mockImplementation(async () => ({
      spec: { selector: { matchLabels: { app: 'test' } } },
      status: { availableReplicas: 2, readyReplicas: 2, replicas: 3 }
    }));
  });

  // ── restartDeployment ──────────────────────────────────

  describe('restartDeployment', () => {
    it('patches with restart annotation and returns success', async () => {
      const result = await restartDeployment('my-app', 'default');

      assert.equal(result.success, true);
      assert.ok(result.message.includes('my-app'));

      const callArgs = mockPatch.mock.calls[0].arguments[0];
      assert.equal(callArgs.name, 'my-app');
      assert.equal(callArgs.namespace, 'default');
      assert.ok(callArgs.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']);
    });

    it('wraps errors as IntegrationError with retryable for 5xx', async () => {
      mockPatch.mock.mockImplementation(async () => {
        const err = new Error('Internal Server Error');
        err.statusCode = 500;
        throw err;
      });

      await assert.rejects(
        () => restartDeployment('my-app'),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.equal(err.integration, 'kubernetes');
          assert.equal(err.retryable, true);
          return true;
        }
      );
    });

    it('wraps errors as non-retryable for 4xx', async () => {
      mockPatch.mock.mockImplementation(async () => {
        const err = new Error('Not Found');
        err.statusCode = 404;
        throw err;
      });

      await assert.rejects(
        () => restartDeployment('my-app'),
        (err) => {
          assert.equal(err.retryable, false);
          return true;
        }
      );
    });
  });

  // ── rollbackDeployment ────────────────────────────────

  describe('rollbackDeployment', () => {
    it('reads deployment, lists ReplicaSets, and patches with old template', async () => {
      mockListRS.mock.mockImplementation(async () => ({
        items: [
          {
            metadata: {
              annotations: { 'deployment.kubernetes.io/revision': '3' },
              ownerReferences: [{ name: 'my-app', kind: 'Deployment' }]
            },
            spec: { template: { spec: { containers: [{ image: 'v3' }] } } }
          },
          {
            metadata: {
              annotations: { 'deployment.kubernetes.io/revision': '2' },
              ownerReferences: [{ name: 'my-app', kind: 'Deployment' }]
            },
            spec: { template: { spec: { containers: [{ image: 'v2' }] } } }
          }
        ]
      }));

      const result = await rollbackDeployment('my-app', undefined, 'default');

      assert.equal(result.success, true);
      assert.ok(result.message.includes('revision 2'));

      // Verify patch was called with the old template
      const patchArgs = mockPatch.mock.calls[0].arguments[0];
      assert.deepEqual(patchArgs.body.spec.template.spec.containers[0].image, 'v2');
    });

    it('throws when no matching revision found', async () => {
      mockListRS.mock.mockImplementation(async () => ({ items: [] }));

      await assert.rejects(
        () => rollbackDeployment('my-app', 99, 'default'),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.ok(err.message.includes('No ReplicaSet found'));
          assert.equal(err.retryable, false);
          return true;
        }
      );
    });
  });

  // ── scaleDeployment ───────────────────────────────────

  describe('scaleDeployment', () => {
    it('patches with target replicas', async () => {
      const result = await scaleDeployment('my-app', 5, 'default');

      assert.equal(result.success, true);

      const callArgs = mockPatch.mock.calls[0].arguments[0];
      assert.equal(callArgs.body.spec.replicas, 5);
    });
  });

  // ── getDeploymentStatus ───────────────────────────────

  describe('getDeploymentStatus', () => {
    it('reads deployment and returns availability info', async () => {
      const result = await getDeploymentStatus('my-app', 'default');

      assert.equal(result.available, true);
      assert.equal(result.ready, 2);
      assert.equal(result.replicas, 3);
    });
  });

  // ── Client caching ────────────────────────────────────

  describe('client caching', () => {
    it('reuses the same client across multiple calls', async () => {
      await restartDeployment('app-a', 'default');
      await scaleDeployment('app-b', 3, 'default');

      assert.equal(mockMakeApiClient.mock.callCount(), 1,
        'makeApiClient should be called only once');
    });

    it('creates new client after _resetClient', async () => {
      await restartDeployment('app-a', 'default');
      _resetClient();
      await scaleDeployment('app-b', 3, 'default');

      assert.equal(mockMakeApiClient.mock.callCount(), 2,
        'makeApiClient should be called again after reset');
    });
  });
});
