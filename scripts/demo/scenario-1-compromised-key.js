// Scenario 1: Compromised API Key — Security Flow
//
// Demonstrates: Geo-anomaly detection, MITRE ATT&CK mapping, threat hunting,
//               containment, and verified resolution.
//
// Usage:
//   node scripts/demo/scenario-1-compromised-key.js               # full run with verification
//   node scripts/demo/scenario-1-compromised-key.js --skip-verify  # inject only, no polling

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dashboard } from './dashboard.js';
import { startPolling, stopPolling } from './agent-poller.js';
import { simulateAlert, simulateLogs, waitForIncident, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-1');
const skipVerify = process.argv.includes('--skip-verify');

export async function runScenario1() {
  const start = Date.now();
  const dashboard = new Dashboard('Compromised API Key', 1);
  dashboard.start();

  // ── Phase 1: Background — normal authentication activity (24h) ────
  dashboard.addActivity('system', 'Injecting background auth logs (200 events)...');
  try {
    await simulateLogs('logs-auth-default', {
      count: 200,
      source_ip: '10.0.1.50',
      source_geo: { country_iso_code: 'US', city_name: 'Portland' },
      user_name: 'svc-payment',
      event_outcome: 'success',
      event_action: 'authentication',
      timespan_hours: 24
    });
    dashboard.addActivity('system', '\u2713 200 normal auth events indexed');
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 1 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 1 aborted at Phase 1 (background auth)');
  }

  // ── Phase 2: Attack — anomalous auth from unexpected location ─────
  dashboard.addActivity('system', 'Injecting attack auth logs (50 events)...');
  try {
    await simulateLogs('logs-auth-default', {
      count: 50,
      source_ip: '203.0.113.42',
      source_geo: { country_iso_code: 'XX', city_name: 'Unknown' },
      user_name: 'svc-payment',
      event_outcome: 'success',
      event_action: 'authentication',
      timespan_hours: 1
    });
    dashboard.addActivity('system', '\u2713 50 anomalous auth events indexed');
  } catch (err) {
    log.error(`Phase 2 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 2 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 1 aborted at Phase 2 (attack auth)');
  }

  // ── Phase 3: Exfiltration — data transfer to C2 server ───────────
  dashboard.addActivity('system', 'Injecting exfiltration events (30 events)...');
  try {
    await simulateLogs('logs-network-default', {
      count: 30,
      source_ip: '203.0.113.42',
      destination_ip: '198.51.100.10',
      event_action: 'connection',
      event_outcome: 'success',
      network_bytes: Math.floor(50 * 1024 * 1024 / 30),
      timespan_hours: 1
    });
    dashboard.addActivity('system', '\u2713 30 exfiltration events indexed');
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 3 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 1 aborted at Phase 3 (exfiltration)');
  }

  // ── Phase 4: Alert — triggers the Vigil pipeline ─────────────────
  dashboard.addActivity('system', 'Injecting alert \u2014 pipeline activating...');
  let alert;
  try {
    alert = await simulateAlert({
      rule_id: 'RULE-GEO-ANOMALY-001',
      rule_name: 'Geographic Anomaly \u2014 API Key Usage from Unexpected Location',
      severity_original: 'high',
      source: {
        ip: '203.0.113.42',
        geo: { country_iso_code: 'XX', city_name: 'Unknown' },
        user_name: 'svc-payment'
      },
      destination: {
        ip: '198.51.100.10',
        port: 443
      },
      affected_asset: {
        id: 'srv-payment-01',
        name: 'srv-payment-01',
        criticality: 'tier-1'
      }
    });
    dashboard.addActivity('system', `\u2713 Alert ${alert.alert_id} indexed \u2014 agents engaging`);
  } catch (err) {
    log.error(`Phase 4 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 4 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 1 aborted at Phase 4 (alert injection)');
  }

  const injectTime = ((Date.now() - start) / 1000).toFixed(1);
  dashboard.addActivity('system', `Data injection complete in ${injectTime}s`);

  // ── Phase 5: Verification — poll for resolved incident ────────────
  if (skipVerify) {
    dashboard.addActivity('system', '--skip-verify: Skipping resolution polling.');
    dashboard.stop();
    return { success: true, duration: injectTime, verified: false };
  }

  // Wait for the incident to be created from the alert
  const incidentId = await waitForIncident(alert.alert_id, 30000);

  if (incidentId) {
    startPolling(incidentId, dashboard);
    // Wait for resolution or timeout (poller handles dashboard.showResult + dashboard.stop)
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
  runScenario1()
    .then(result => {
      console.log('Scenario 1 finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
