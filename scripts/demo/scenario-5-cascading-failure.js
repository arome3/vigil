// Scenario 5: Cascading Service Failure (Memory Leak) — Operational Flow
//
// Demonstrates: Sentinel anomaly detection, cascading multi-service failure,
//               pod-restart runbook, low-confidence change correlation
//               (no deployment found), synthetic investigation path.
//
// Pipeline: Sentinel -> Investigator (synthetic) -> Commander -> Executor -> Verifier
// Runbook:  runbook-pod-restart (Pod Restart for Unhealthy Services)
//
// Usage:
//   node scripts/demo/scenario-5-cascading-failure.js               # full run with verification
//   node scripts/demo/scenario-5-cascading-failure.js --skip-verify  # inject only, no polling

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dashboard } from './dashboard.js';
import { startPolling, stopPolling } from './agent-poller.js';
import { simulateAlert, simulateErrorSpike, waitForIncident, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-5');
const skipVerify = process.argv.includes('--skip-verify');


export async function runScenario5() {
  const start = Date.now();
  const dashboard = new Dashboard('Cascading Service Failure (Memory Leak)', 5);
  dashboard.start();

  // ── Phase 1: Background — healthy service logs (6h) ────────────────────
  dashboard.addActivity('system', 'Injecting healthy service logs (200 events, 6h)...');
  try {
    await simulateErrorSpike({
      service_name: 'api-gateway',
      error_rate: 0.01,
      error_message: 'Transient timeout',
      total_events: 200,
      timespan_minutes: 360,
      affected_services: []
    });
    dashboard.addActivity('system', '\u2713 200 healthy service events indexed (1% baseline)');
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 1 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 5 aborted at Phase 1 (healthy baseline)');
  }

  // ── Phase 2: Degradation — rising latency + errors (30 min) ───────────
  dashboard.addActivity('system', 'Injecting degradation events (400 events, 35% error rate)...');
  try {
    await simulateErrorSpike({
      service_name: 'api-gateway',
      error_rate: 0.35,
      error_message: 'OutOfMemoryError: Java heap space \u2014 request processing failed',
      total_events: 400,
      timespan_minutes: 30,
      affected_services: []
    });
    dashboard.addActivity('system', '\u2713 400 degradation events indexed (memory leak pattern)');
  } catch (err) {
    log.error(`Phase 2 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 2 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 5 aborted at Phase 2 (degradation)');
  }

  // ── Phase 3: Cascade — downstream failures propagate ──────────────────
  dashboard.addActivity('system', 'Injecting cascading downstream failures (200 events)...');
  try {
    await simulateErrorSpike({
      service_name: 'api-gateway',
      error_rate: 0.55,
      error_message: 'OutOfMemoryError: Java heap space \u2014 service unresponsive',
      total_events: 200,
      timespan_minutes: 15,
      affected_services: ['payment-service', 'notification-svc']
    });
    dashboard.addActivity('system', '\u2713 200 cascading failure events (api-gateway + 2 downstream)');
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 3 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 5 aborted at Phase 3 (cascading failure)');
  }

  // ── Phase 4: Alert — sentinel operational alert ───────────────────────
  dashboard.addActivity('system', 'Injecting sentinel alert \u2014 pipeline activating...');
  let alert;
  try {
    alert = await simulateAlert({
      rule_id: 'sentinel-memory-leak-001',
      rule_name: 'Sentinel \u2014 Sustained Memory Pressure with Cascading Service Degradation',
      severity_original: 'high',
      // Sentinel report fields used by buildSentinelReport()
      affected_service_tier: 'tier-2',
      affected_assets: ['api-gateway', 'payment-service', 'notification-svc'],
      root_cause_assessment: 'Memory leak pattern detected on api-gateway with cascading failures to downstream services',
      change_correlation: { matched: false, confidence: 'low' },
      // Standard alert fields for triage
      source: {
        ip: '10.0.1.10',
        user_name: 'api-gateway'
      },
      destination: {
        ip: '10.0.1.10',
        port: 8080
      },
      affected_asset: {
        id: 'srv-api-gateway-01',
        name: 'api-gateway',
        criticality: 'tier-2'
      }
    });
    dashboard.addActivity('system', `\u2713 Alert ${alert.alert_id} indexed \u2014 agents engaging`);
  } catch (err) {
    log.error(`Phase 4 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 4 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 5 aborted at Phase 4 (alert injection)');
  }

  const injectTime = ((Date.now() - start) / 1000).toFixed(1);
  dashboard.addActivity('system', `Data injection complete in ${injectTime}s`);

  // ── Verification — poll for resolved incident ─────────────────────────
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
  runScenario5()
    .then(result => {
      console.log('Scenario 5 finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
