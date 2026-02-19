// Stabilization wait — delays health checks after remediation
// to allow metrics to stabilize through Kubernetes pod rollouts,
// load balancer health checks, and metric pipeline ingestion.

import { createLogger } from '../../utils/logger.js';

const log = createLogger('verifier-stabilization');

/**
 * Wait for the specified number of seconds before proceeding with
 * health checks. Logs progress at regular intervals.
 *
 * @param {number} seconds - Seconds to wait (0 or negative skips the wait)
 * @returns {Promise<void>}
 */
export async function waitForStabilization(seconds) {
  if (seconds <= 0) {
    log.info('Stabilization wait skipped (0 seconds)');
    return;
  }

  log.info(`Waiting ${seconds}s for metrics to stabilize after remediation...`);

  let elapsed = 0;

  while (elapsed < seconds) {
    const waitTime = Math.min(15, seconds - elapsed);
    await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
    elapsed += waitTime;
    log.info(`Stabilization: ${elapsed}/${seconds}s elapsed`);
  }

  log.info('Stabilization wait complete — proceeding with health checks');
}
