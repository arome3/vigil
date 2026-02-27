// Scenario 3: Brute Force Login Attack — Security Flow (Skip Threat Hunt)
//
// Demonstrates: High-volume failed auth detection, multi-IP correlation,
//               IP block runbook, and credential compromise triage.
//               MITRE ATT&CK: T1110 (Brute Force).
//
// Pipeline: Triage -> Investigator (plan_remediation) -> Commander -> Executor -> Verifier
// Runbook:  runbook-ip-block (Malicious IP Blocking via WAF)
//
// Usage:
//   node scripts/demo/scenario-3-brute-force.js               # full run with verification
//   node scripts/demo/scenario-3-brute-force.js --skip-verify  # inject only, no polling

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dashboard } from './dashboard.js';
import { startPolling, stopPolling } from './agent-poller.js';
import { simulateAlert, simulateLogs, waitForIncident, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-3');
const skipVerify = process.argv.includes('--skip-verify');

export async function runScenario3() {
  const start = Date.now();
  const dashboard = new Dashboard('Brute Force Login Attack', 3);
  dashboard.start();

  // ── Phase 1: Background — normal auth activity for admin-portal (24h) ──
  dashboard.addActivity('system', 'Injecting background auth logs (300 events)...');
  try {
    await simulateLogs('logs-auth-default', {
      count: 300,
      source_ip: '10.0.2.15',
      source_geo: { country_iso_code: 'US', city_name: 'Seattle' },
      user_name: 'admin-portal',
      event_outcome: 'success',
      event_action: 'authentication',
      timespan_hours: 24
    });
    dashboard.addActivity('system', '\u2713 300 normal auth events indexed');
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 1 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at Phase 1 (background auth)');
  }

  // ── Phase 2: Attack — rapid failed logins from 3 IPs (30 min) ─────────
  dashboard.addActivity('system', 'Injecting brute force attack (500 failed logins, 3 IPs)...');
  const attackIPs = [
    { ip: '185.220.101.34', geo: { country_iso_code: 'RU', city_name: 'Moscow' } },
    { ip: '45.155.205.19',  geo: { country_iso_code: 'CN', city_name: 'Shanghai' } },
    { ip: '91.240.118.72',  geo: { country_iso_code: 'IR', city_name: 'Tehran' } }
  ];
  const targetsPerIP = [167, 167, 166];
  const targetUsers = ['admin', 'root', 'svc-deploy', 'admin-portal', 'db-admin'];

  try {
    for (let i = 0; i < attackIPs.length; i++) {
      await simulateLogs('logs-auth-default', {
        count: targetsPerIP[i],
        source_ip: attackIPs[i].ip,
        source_geo: attackIPs[i].geo,
        user_name: targetUsers[i % targetUsers.length],
        event_outcome: 'failure',
        event_action: 'authentication',
        timespan_hours: 0.5
      });
    }
    dashboard.addActivity('system', '\u2713 500 failed auth events indexed across 3 source IPs');
  } catch (err) {
    log.error(`Phase 2 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 2 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at Phase 2 (brute force attack)');
  }

  // ── Phase 3: Partial success — credential compromise from attack IP ────
  dashboard.addActivity('system', 'Injecting credential compromise (10 successful logins)...');
  try {
    await simulateLogs('logs-auth-default', {
      count: 10,
      source_ip: '185.220.101.34',
      source_geo: { country_iso_code: 'RU', city_name: 'Moscow' },
      user_name: 'admin-portal',
      event_outcome: 'success',
      event_action: 'authentication',
      timespan_hours: 0.25
    });
    dashboard.addActivity('system', '\u2713 10 successful logins from attack IP (credential compromise)');
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 3 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at Phase 3 (credential compromise)');
  }

  // ── Phase 4: Lateral movement — network connections from compromised account ──
  dashboard.addActivity('system', 'Injecting lateral movement events (20 events)...');
  try {
    await simulateLogs('logs-network-default', {
      count: 20,
      source_ip: '185.220.101.34',
      destination_ip: '10.0.2.30',
      event_action: 'connection',
      event_outcome: 'success',
      network_bytes: 2048,
      timespan_hours: 0.5
    });
    dashboard.addActivity('system', '\u2713 20 lateral movement events indexed');
  } catch (err) {
    log.error(`Phase 4 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 4 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at Phase 4 (lateral movement)');
  }

  // ── Phase 5: Alert — triggers the Vigil pipeline ──────────────────────
  dashboard.addActivity('system', 'Injecting alert \u2014 pipeline activating...');
  let alert;
  try {
    alert = await simulateAlert({
      rule_id: 'RULE-BRUTE-FORCE-001',
      rule_name: 'Brute Force Login Attack \u2014 Multiple Failed Authentications',
      severity_original: 'high',
      source: {
        ip: '185.220.101.34',
        geo: { country_iso_code: 'RU', city_name: 'Moscow' },
        user_name: 'admin-portal'
      },
      destination: {
        ip: '10.0.2.15',
        port: 443
      },
      affected_asset: {
        id: 'srv-user-01',
        name: 'srv-user-01',
        criticality: 'tier-1'
      }
    });
    dashboard.addActivity('system', `\u2713 Alert ${alert.alert_id} indexed \u2014 agents engaging`);
  } catch (err) {
    log.error(`Phase 5 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Phase 5 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at Phase 5 (alert injection)');
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
  runScenario3()
    .then(result => {
      console.log('Scenario 3 finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
