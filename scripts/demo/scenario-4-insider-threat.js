// Scenario 4: Insider Threat — Off-Hours Data Access
//
// Demonstrates: Temporal anomaly detection, PCI-DSS data access monitoring,
//               full threat hunt path, and account-disable runbook (Okta).
//               Critical severity + tier-1 asset = highest priority score.
//
// Pipeline: Triage -> Investigator -> Threat Hunter -> Commander -> Executor -> Verifier
// Runbook:  runbook-account-disable (Compromised Account Suspension via Okta)
//
// Usage:
//   node scripts/demo/scenario-4-insider-threat.js               # full run with verification
//   node scripts/demo/scenario-4-insider-threat.js --skip-verify  # inject only, no polling

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dashboard } from './dashboard.js';
import { startPolling, stopPolling } from './agent-poller.js';
import { simulateAlert, simulateLogs, waitForIncident, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-4');
const skipVerify = process.argv.includes('--skip-verify');

export async function runScenario4() {
  const start = Date.now();
  const dashboard = new Dashboard('Insider Threat \u2014 Off-Hours Data Access', 4);
  dashboard.start();

  // ── Phase 1: Background — normal business-hours data access (7 days) ──
  dashboard.addActivity('system', 'Injecting normal data access logs (150 events, 7 days)...');
  try {
    await simulateLogs('logs-auth-default', {
      count: 150,
      source_ip: '10.0.5.20',
      source_geo: { country_iso_code: 'US', city_name: 'New York' },
      user_name: 'db-admin',
      event_outcome: 'success',
      event_action: 'data-access',
      timespan_hours: 168
    });
    dashboard.addActivity('system', '\u2713 150 normal business-hours data access events indexed');
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 1 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 4 aborted at Phase 1 (background data access)');
  }

  // ── Phase 2: Anomaly — off-hours access to PCI data (2am-4am) ────────
  dashboard.addActivity('system', 'Injecting off-hours PCI data access (80 events, 2am-4am)...');
  try {
    await simulateLogs('logs-auth-default', {
      count: 80,
      source_ip: '10.0.5.20',
      source_geo: { country_iso_code: 'US', city_name: 'New York' },
      user_name: 'db-admin',
      event_outcome: 'success',
      event_action: 'data-access',
      destination_ip: '10.0.10.5',
      timespan_hours: 2
    });
    dashboard.addActivity('system', '\u2713 80 off-hours PCI data access events indexed');
  } catch (err) {
    log.error(`Phase 2 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 2 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 4 aborted at Phase 2 (off-hours data access)');
  }

  // ── Phase 3: Exfiltration — large network transfers to external IP ────
  dashboard.addActivity('system', 'Injecting exfiltration events (20 events, ~200MB)...');
  try {
    await simulateLogs('logs-network-default', {
      count: 20,
      source_ip: '10.0.5.20',
      destination_ip: '104.248.55.78',
      event_action: 'connection',
      event_outcome: 'success',
      network_bytes: Math.floor(200 * 1024 * 1024 / 20),
      timespan_hours: 2
    });
    dashboard.addActivity('system', '\u2713 20 large network transfer events indexed (~200MB)');
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 3 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 4 aborted at Phase 3 (exfiltration)');
  }

  // ── Phase 4: Alert — triggers the Vigil pipeline ──────────────────────
  dashboard.addActivity('system', 'Injecting alert \u2014 pipeline activating...');
  let alert;
  try {
    alert = await simulateAlert({
      rule_id: 'RULE-INSIDER-ANOMALY-001',
      rule_name: 'Insider Threat \u2014 Off-Hours PCI Data Access with External Transfer',
      severity_original: 'critical',
      source: {
        ip: '10.0.5.20',
        geo: { country_iso_code: 'US', city_name: 'New York' },
        user_name: 'db-admin'
      },
      destination: {
        ip: '104.248.55.78',
        port: 443
      },
      affected_asset: {
        id: 'srv-payment-01',
        name: 'srv-payment-01',
        criticality: 'tier-1',
        compliance: ['PCI-DSS']
      }
    });
    dashboard.addActivity('system', `\u2713 Alert ${alert.alert_id} indexed \u2014 agents engaging`);
  } catch (err) {
    log.error(`Phase 4 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 4 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 4 aborted at Phase 4 (alert injection)');
  }

  const injectTime = ((Date.now() - start) / 1000).toFixed(1);
  dashboard.addActivity('system', `Data injection complete in ${injectTime}s`);

  // ── Verification — poll for resolved incident ─────────────────────────
  if (skipVerify) {
    dashboard.addActivity('system', '--skip-verify: Skipping resolution polling.');
    dashboard.stop();
    return { success: true, duration: injectTime, verified: false };
  }

  // Wait for the incident to be created from the alert
  const incidentId = await waitForIncident(alert.alert_id, 30000);

  if (incidentId) {
    startPolling(incidentId, dashboard);
    const incident = await waitForResolution({ timeoutMs: 420_000, intervalMs: 15_000 });
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
  runScenario4()
    .then(result => {
      console.log('Scenario 4 finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
