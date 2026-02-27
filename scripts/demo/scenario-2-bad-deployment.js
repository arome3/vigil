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
import { Dashboard } from './dashboard.js';
import { startPolling, stopPolling } from './agent-poller.js';
import { simulateAlert, simulateGitHubWebhook, simulateErrorSpike, waitForIncident, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-2');
const skipVerify = process.argv.includes('--skip-verify');

/**
 * Wait with a live countdown and educational context about LOOKUP JOIN.
 */
async function waitWithCountdown(dashboard, totalSeconds) {
  dashboard.addActivity('system', '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  dashboard.addActivity('system', 'Simulating real deployment-to-error gap...');
  dashboard.addActivity('system', 'In production, errors don\'t appear instantly');
  dashboard.addActivity('system', 'after a bad deploy. There\'s always a gap.');
  dashboard.addActivity('system', 'Vigil\'s LOOKUP JOIN correlates events across');
  dashboard.addActivity('system', 'this exact time window.');
  dashboard.addActivity('system', '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    dashboard.updateCountdown(`\u23F3 Waiting for errors to surface... ${remaining}s`);
    await new Promise(r => setTimeout(r, 1000));
  }

  dashboard.clearCountdown();
  dashboard.addActivity('system', '\u2713 42 seconds elapsed \u2014 errors emerging');
}


export async function runScenario2() {
  const start = Date.now();
  const dashboard = new Dashboard('Cascading Deployment Failure', 2);
  dashboard.start();

  // ── Phase 1: Deployment webhook — GitHub push event ───────────────
  dashboard.addActivity('system', 'Injecting GitHub deployment webhook...');
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
    dashboard.addActivity('system', `\u2713 Deployment event indexed: ${deployment.event_id}`);
    dashboard.addActivity('system', `Commit a3f8c21 by @jsmith (PR #847)`);
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 1 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 2 aborted at Phase 1 (deployment webhook)');
  }

  // ── Phase 2: Wait 42 seconds — realistic deploy-to-error gap ──────
  await waitWithCountdown(dashboard, 42);

  // ── Phase 3: Error spike — downstream services fail ───────────────
  dashboard.addActivity('system', 'Injecting error spike (500 events, 23% error rate)...');
  try {
    const result = await simulateErrorSpike({
      service_name: 'api-gateway',
      error_rate: 0.23,
      error_message: 'Missing required header: X-Request-ID',
      total_events: 500,
      timespan_minutes: 5,
      affected_services: ['payment-service', 'user-service', 'notification-svc']
    });
    dashboard.addActivity('system', `\u2713 ${result.indexed} service log events indexed`);
    dashboard.addActivity('system', `  (${result.primary_events} primary, ${result.downstream_events} downstream)`);
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 3 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 2 aborted at Phase 3 (error spike)');
  }

  // ── Phase 4: Alert — Sentinel would detect this; we inject explicitly ──
  dashboard.addActivity('system', 'Injecting operational alert (Sentinel detection)...');
  let alert;
  try {
    alert = await simulateAlert({
      rule_id: 'sentinel-error-spike-001',
      rule_name: 'Sentinel — Error Rate Spike After Deployment (api-gateway)',
      severity_original: 'high',
      // Sentinel report fields used by buildSentinelReport()
      affected_service_tier: 'tier-1',
      affected_assets: ['api-gateway', 'payment-service', 'user-service'],
      root_cause_assessment: 'Error rate spike (23%) on api-gateway correlated with deployment a3f8c21',
      change_correlation: {
        matched: true,
        confidence: 'high',
        commit_sha: 'a3f8c21',
        pr_number: 847,
        commit_author: 'jsmith'
      },
      // Standard alert fields for triage
      source: {
        ip: '10.0.1.100',
        service_name: 'api-gateway'
      },
      affected_asset: {
        id: 'srv-api-gateway-01',
        name: 'api-gateway',
        criticality: 'tier-1'
      }
    });
    dashboard.addActivity('system', `\u2713 Alert ${alert.alert_id} indexed — agents engaging`);
  } catch (err) {
    log.error(`Phase 4 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 4 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 2 aborted at Phase 4 (alert injection)');
  }

  const injectTime = ((Date.now() - start) / 1000).toFixed(1);
  dashboard.addActivity('system', `Data injection complete in ${injectTime}s`);

  // ── Phase 5: Verification — poll for resolved incident ────────────
  if (skipVerify) {
    dashboard.addActivity('system', '--skip-verify: Skipping resolution polling.');
    dashboard.stop();
    return { success: true, duration: injectTime, verified: false };
  }

  const incidentId = await waitForIncident(alert.alert_id, 30000);

  if (incidentId) {
    startPolling(incidentId, dashboard);
    const incident = await waitForResolution({ timeoutMs: 480_000, intervalMs: 15_000 });
    const totalTime = ((Date.now() - start) / 1000).toFixed(1);

    stopPolling();
    dashboard.stop();

    if (incident) {
      return { success: true, duration: totalTime, verified: true, incident };
    }
    return { success: true, duration: totalTime, verified: false };
  }

  dashboard.addActivity('system', '\u26A0 Timeout waiting for incident creation');
  dashboard.stop();
  return { success: true, duration: ((Date.now() - start) / 1000).toFixed(1), verified: false };
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
