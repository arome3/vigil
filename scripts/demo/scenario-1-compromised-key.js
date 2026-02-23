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
import { simulateAlert, simulateLogs, waitForResolution } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-scenario-1');
const skipVerify = process.argv.includes('--skip-verify');

export async function runScenario1() {
  const start = Date.now();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  Scenario 1: Compromised API Key — Security Flow      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // ── Phase 1: Background — normal authentication activity (24h) ────
  console.log('[1/4] Injecting background auth logs (200 events, 24h span)...');
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
    console.log('  -> 200 normal auth events indexed.\n');
  } catch (err) {
    log.error(`Phase 1 failed: ${err.message}`);
    throw new Error('Scenario 1 aborted at Phase 1 (background auth)');
  }

  // ── Phase 2: Attack — anomalous auth from unexpected location ─────
  console.log('[2/4] Injecting attack auth logs (50 events, 1h span)...');
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
    console.log('  -> 50 anomalous auth events indexed.\n');
  } catch (err) {
    log.error(`Phase 2 failed: ${err.message}`);
    throw new Error('Scenario 1 aborted at Phase 2 (attack auth)');
  }

  // ── Phase 3: Exfiltration — data transfer to C2 server ───────────
  console.log('[3/4] Injecting exfiltration network events (30 events, 1h span)...');
  try {
    await simulateLogs('logs-network-default', {
      count: 30,
      source_ip: '203.0.113.42',
      destination_ip: '198.51.100.10',
      event_action: 'connection',
      event_outcome: 'success',
      network_bytes: Math.floor(50 * 1024 * 1024 / 30), // ~1.7MB per event, ~50MB total
      timespan_hours: 1
    });
    console.log('  -> 30 network exfiltration events indexed.\n');
  } catch (err) {
    log.error(`Phase 3 failed: ${err.message}`);
    throw new Error('Scenario 1 aborted at Phase 3 (exfiltration)');
  }

  // ── Phase 4: Alert — triggers the Vigil pipeline ─────────────────
  console.log('[4/4] Injecting alert to vigil-alerts-default...');
  try {
    const alert = await simulateAlert({
      rule_id: 'RULE-GEO-ANOMALY-001',
      rule_name: 'Geographic Anomaly — API Key Usage from Unexpected Location',
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
    console.log(`  -> Alert indexed: ${alert.alert_id}\n`);
  } catch (err) {
    log.error(`Phase 4 failed: ${err.message}`);
    throw new Error('Scenario 1 aborted at Phase 4 (alert injection)');
  }

  const injectTime = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Data injection complete in ${injectTime}s.`);
  console.log('');
  console.log('Expected agent flow:');
  console.log('  Triage -> Investigator -> Threat Hunter -> Commander -> Executor -> Verifier');
  console.log('  Target time: ~4m 12s\n');

  // ── Phase 5: Verification — poll for resolved incident ────────────
  if (skipVerify) {
    console.log('--skip-verify: Skipping resolution polling.\n');
    return { success: true, duration: injectTime, verified: false };
  }

  console.log('Waiting for pipeline to resolve incident...');
  const incident = await waitForResolution({ timeoutMs: 420_000, intervalMs: 15_000 });

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
  runScenario1()
    .then(result => {
      console.log('Scenario 1 finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
