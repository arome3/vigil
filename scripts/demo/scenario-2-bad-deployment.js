// Scenario 2: Bad Deployment — Operational Flow with Change Correlation
//
// Demonstrates: Error spike detection, LOOKUP JOIN change correlation,
//               surgical rollback, and service health verification.
//
// Usage:
//   node scripts/demo/scenario-2-bad-deployment.js               # full run with verification
//   node scripts/demo/scenario-2-bad-deployment.js --skip-verify  # inject only, no polling

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateGitHubWebhook, simulateErrorSpike, wait, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-2');
const skipVerify = process.argv.includes('--skip-verify');

export async function runScenario2() {
  const start = Date.now();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  Scenario 2: Bad Deployment — Change Correlation      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // ── Phase 1: Deployment webhook — GitHub push event ───────────────
  console.log('[1/3] Injecting GitHub deployment webhook...');
  try {
    const deployment = await simulateGitHubWebhook({
      event_type: 'deployment',
      repository: 'acme-corp/api-gateway',
      branch: 'main',
      service_name: 'api-gateway',
      commit: {
        sha: 'a3f8c21',
        message: 'Add strict header validation to API Gateway',
        author: 'jsmith',
        author_email: 'jsmith@acme-corp.com'
      },
      pr: {
        number: 847,
        title: 'Add strict header validation to API Gateway',
        merged_by: 'jsmith'
      },
      deployment: {
        environment: 'production',
        status: 'success',
        previous_sha: 'b7e4d90'
      },
      files_changed: [
        'src/middleware/header-validation.js',
        'src/config/required-headers.json'
      ],
      additions: 47,
      deletions: 3
    });
    console.log(`  -> Deployment event indexed: ${deployment.event_id}`);
    console.log('     Commit: a3f8c21 by jsmith (PR #847)\n');
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    throw new Error('Scenario 2 aborted at Phase 1 (deployment webhook)');
  }

  // ── Phase 2: Wait 42 seconds — realistic deploy-to-error gap ──────
  console.log('[2/3] Waiting 42 seconds (realistic deployment-to-error gap)...');
  await wait(42_000);
  console.log('  -> 42 seconds elapsed.\n');

  // ── Phase 3: Error spike — downstream services fail ───────────────
  console.log('[3/3] Injecting error spike (500 events, 23% error rate, 5 min span)...');
  try {
    const result = await simulateErrorSpike({
      service_name: 'api-gateway',
      error_rate: 0.23,
      error_message: 'Missing required header: X-Request-ID',
      total_events: 500,
      timespan_minutes: 5,
      affected_services: ['payment-service', 'user-service', 'notification-svc']
    });
    console.log(`  -> ${result.indexed} service log events indexed (${result.primary_events} primary, ${result.downstream_events} downstream).\n`);
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    throw new Error('Scenario 2 aborted at Phase 3 (error spike)');
  }

  const injectTime = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Data injection complete in ${injectTime}s.`);
  console.log('');
  console.log('Expected agent flow:');
  console.log('  Sentinel -> Investigator (LOOKUP JOIN) -> Commander -> Executor -> Verifier');
  console.log('  Target time: ~5m 47s');
  console.log('  Expected verification: error rate returns to 0.12%\n');

  // ── Phase 4: Verification — poll for resolved incident ────────────
  if (skipVerify) {
    console.log('--skip-verify: Skipping resolution polling.\n');
    return { success: true, duration: injectTime, verified: false };
  }

  console.log('Waiting for pipeline to resolve incident...');
  const incident = await waitForResolution({ timeoutMs: 480_000, intervalMs: 15_000 });

  const totalTime = ((Date.now() - start) / 1000).toFixed(1);

  if (incident) {
    console.log(`\nIncident ${incident.incident_id} resolved in ${totalTime}s.`);
    return { success: true, duration: totalTime, verified: true, incident };
  }

  console.log(`\nResolution not detected after ${totalTime}s (pipeline may still be running).`);
  return { success: true, duration: totalTime, verified: false };
}

// Self-execute when run directly
const thisFile = resolve(fileURLToPath(import.meta.url));
const entryFile = resolve(process.argv[1]);

if (thisFile === entryFile) {
  runScenario2()
    .then(result => {
      console.log('Scenario 2 finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
