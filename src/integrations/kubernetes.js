// Kubernetes API integration — deployment restart, rollback, scaling, and status.

import * as k8s from '@kubernetes/client-node';
import { createLogger } from '../utils/logger.js';
import { IntegrationError } from './base-client.js';

const log = createLogger('integration-k8s');

const K8S_CONTEXT = process.env.K8S_CONTEXT || 'minikube';
const DEMO_NAMESPACE = process.env.DEMO_NAMESPACE || 'vigil-demo';

const STRATEGIC_MERGE_PATCH = { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } };

// ─── Internal helpers ─────────────────────────────────────────────────

let _appsApi = null;

function buildAppsApi() {
  if (!_appsApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    kc.setCurrentContext(K8S_CONTEXT);
    _appsApi = kc.makeApiClient(k8s.AppsV1Api);
  }
  return _appsApi;
}

/** Reset cached client — for test isolation only. */
export function _resetClient() { _appsApi = null; }

function ns(namespace) {
  return namespace || DEMO_NAMESPACE;
}

// ─── Exported functions ───────────────────────────────────────────────

/**
 * Restart a deployment by patching the pod template annotation.
 * Equivalent to `kubectl rollout restart deployment/<name>`.
 *
 * @param {string} deploymentName
 * @param {string} [namespace]
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function restartDeployment(deploymentName, namespace) {
  const appsApi = buildAppsApi();
  const target = ns(namespace);
  log.info(`Restarting deployment ${deploymentName} in ${target}`);

  try {
    await appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: target,
        body: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
                }
              }
            }
          }
        }
      },
      STRATEGIC_MERGE_PATCH
    );

    const message = `Deployment ${deploymentName} restarted in ${target}`;
    log.info(message);
    return { success: true, message };
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const statusCode = err.statusCode || err.body?.code;
    const retryable = statusCode >= 500 || statusCode === 429 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code);
    const message = `Failed to restart ${deploymentName}: ${err.body?.message || err.message}`;
    log.error(message);
    throw new IntegrationError(message, { integration: 'kubernetes', statusCode, retryable });
  }
}

/**
 * Rollback a deployment to a previous revision by restoring an older
 * ReplicaSet's pod template spec onto the Deployment.
 *
 * @param {string} deploymentName
 * @param {number} [revision] - Target revision number (omit for previous)
 * @param {string} [namespace]
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function rollbackDeployment(deploymentName, revision, namespace) {
  const appsApi = buildAppsApi();
  const target = ns(namespace);
  log.info(`Rolling back deployment ${deploymentName} in ${target} to revision ${revision || 'previous'}`);

  try {
    // 1. Read the deployment to get its label selector
    const deployment = await appsApi.readNamespacedDeployment({
      name: deploymentName,
      namespace: target
    });

    const matchLabels = deployment.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(matchLabels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    // 2. List ReplicaSets matching the deployment's selector
    const rsList = await appsApi.listNamespacedReplicaSet({
      namespace: target,
      labelSelector
    });

    // 3. Filter to ReplicaSets owned by this deployment
    const owned = rsList.items.filter(rs =>
      rs.metadata?.ownerReferences?.some(
        ref => ref.name === deploymentName && ref.kind === 'Deployment'
      )
    );

    // 4. Sort by revision annotation (descending — highest/current first)
    owned.sort((a, b) => {
      const revA = Number(a.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0);
      const revB = Number(b.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0);
      return revB - revA;
    });

    // 5. Find target ReplicaSet (specific revision or previous)
    let targetRS;
    if (revision) {
      targetRS = owned.find(rs =>
        rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] === String(revision)
      );
    } else {
      targetRS = owned[1]; // index 0 is current, index 1 is previous
    }

    if (!targetRS) {
      throw new IntegrationError(
        `No ReplicaSet found for revision ${revision || 'previous'} of ${deploymentName}`,
        { integration: 'kubernetes', retryable: false }
      );
    }

    // 6. Patch the Deployment's pod template with the old ReplicaSet's template
    await appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: target,
        body: { spec: { template: targetRS.spec?.template } }
      },
      STRATEGIC_MERGE_PATCH
    );

    const targetRev = targetRS.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 'unknown';
    const message = `Deployment ${deploymentName} rolled back to revision ${targetRev} in ${target}`;
    log.info(message);
    return { success: true, message };
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const statusCode = err.statusCode || err.body?.code;
    const retryable = statusCode >= 500 || statusCode === 429 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code);
    const message = `Failed to rollback ${deploymentName}: ${err.body?.message || err.message}`;
    log.error(message);
    throw new IntegrationError(message, { integration: 'kubernetes', statusCode, retryable });
  }
}

/**
 * Scale a deployment to a target replica count.
 *
 * @param {string} deploymentName
 * @param {number} replicas
 * @param {string} [namespace]
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function scaleDeployment(deploymentName, replicas, namespace) {
  const appsApi = buildAppsApi();
  const target = ns(namespace);
  log.info(`Scaling deployment ${deploymentName} to ${replicas} replicas in ${target}`);

  try {
    await appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: target,
        body: { spec: { replicas } }
      },
      STRATEGIC_MERGE_PATCH
    );

    const message = `Deployment ${deploymentName} scaled to ${replicas} replicas in ${target}`;
    log.info(message);
    return { success: true, message };
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const statusCode = err.statusCode || err.body?.code;
    const retryable = statusCode >= 500 || statusCode === 429 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code);
    const message = `Failed to scale ${deploymentName}: ${err.body?.message || err.message}`;
    log.error(message);
    throw new IntegrationError(message, { integration: 'kubernetes', statusCode, retryable });
  }
}

/**
 * Get deployment status — availability, readiness, and replica count.
 *
 * @param {string} deploymentName
 * @param {string} [namespace]
 * @returns {Promise<{available: boolean, ready: number, replicas: number}>}
 */
export async function getDeploymentStatus(deploymentName, namespace) {
  const appsApi = buildAppsApi();
  const target = ns(namespace);
  log.info(`Getting status for deployment ${deploymentName} in ${target}`);

  try {
    const response = await appsApi.readNamespacedDeployment({
      name: deploymentName,
      namespace: target
    });

    const status = response.status || {};
    return {
      available: (status.availableReplicas || 0) > 0,
      ready: status.readyReplicas || 0,
      replicas: status.replicas || 0
    };
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const statusCode = err.statusCode || err.body?.code;
    const retryable = statusCode >= 500 || statusCode === 429 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code);
    const message = `Failed to get status for ${deploymentName}: ${err.body?.message || err.message}`;
    log.error(message);
    throw new IntegrationError(message, { integration: 'kubernetes', statusCode, retryable });
  }
}
