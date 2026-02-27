// Reflection Loop: Self-Healing Failure
//
// Demonstrates: Verifier failure detection, reflection loop (re-investigation),
//               self-correcting remediation pipeline.
//
// The pipeline runs twice:
//   Pass 1: Restart pods (fails — root cause is a connection leak, not resource exhaustion)
//   Pass 2: Increase pool size + flag hotfix (succeeds)
//
// Usage:
//   node scripts/demo/scenario-reflection-loop.js
//   node scripts/demo/scenario-reflection-loop.js --skip-verify

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dashboard } from './dashboard.js';
import { startPolling, stopPolling } from './agent-poller.js';
import {
  simulateAlert,
  simulateErrorSpike,
  waitForIncident,
  waitForIncidentStatus,
  waitForResolution
} from './utils.js';
import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-reflection-loop');
const skipVerify = process.argv.includes('--skip-verify');

/**
 * Inject metric-style docs into vigil-metrics-default with a specified error rate.
 * Uses the same field schema the verifier's ES|QL health-comparison query expects:
 *   service.name, transaction.duration.us, event.outcome
 */
async function injectMetrics(serviceName, { count = 500, errorRate = 0.005, timespanMinutes = 5 } = {}) {
  const now = Date.now();
  const spanMs = timespanMinutes * 60 * 1000;
  const docs = [];

  for (let i = 0; i < count; i++) {
    const ts = new Date(now - Math.floor(Math.random() * spanMs));
    const outcome = Math.random() < errorRate ? 'failure' : 'success';
    // Unhealthy: high latency on errors, normal on success
    const latency = outcome === 'failure'
      ? 500_000 + Math.floor(Math.random() * 500_000)  // 500ms-1s
      : 30_000 + Math.floor(Math.random() * 20_000);    // 30-50ms
    docs.push(
      { create: { _index: 'vigil-metrics-default' } },
      {
        '@timestamp': ts.toISOString(),
        'service.name': serviceName,
        'transaction.duration.us': latency,
        'event.outcome': outcome,
        'system.cpu.total.pct': outcome === 'failure' ? 0.85 + Math.random() * 0.1 : 0.2 + Math.random() * 0.3,
        'system.memory.used.pct': outcome === 'failure' ? 0.9 + Math.random() * 0.05 : 0.4 + Math.random() * 0.2
      }
    );
  }

  await client.bulk({ operations: docs, refresh: 'wait_for' });
  return count;
}

export async function runReflectionLoop() {
  const start = Date.now();
  const dashboard = new Dashboard('Self-Healing Failure', 'rl', { label: 'Reflection Loop', autoApprove: true });
  dashboard.start();

  // ── Wave 1: Initial anomaly — connection pool exhaustion ──────
  dashboard.addActivity('system', 'Injecting connection pool exhaustion events (300 events)...');
  try {
    await simulateErrorSpike({
      service_name: 'order-service',
      error_rate: 0.45,
      error_message: 'Connection pool exhausted: max connections (50) reached',
      total_events: 300,
      timespan_minutes: 3,
      affected_services: []
    });
    dashboard.addActivity('system', '\u2713 300 error events indexed (45% error rate)');
  } catch (err) {
    log.error(`Wave 1 failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Wave 1 failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at Wave 1 (error spike)');
  }

  // ── Alert — triggers the pipeline ──────────────────────────────
  dashboard.addActivity('system', 'Injecting alert \u2014 pipeline activating...');
  let alert;
  try {
    alert = await simulateAlert({
      rule_id: 'RULE-CONN-POOL-001',
      rule_name: 'Connection Pool Exhaustion \u2014 order-service',
      severity_original: 'critical',
      affected_asset: {
        id: 'srv-order-01',
        name: 'order-service',
        criticality: 'tier-1'
      }
    });
    dashboard.addActivity('system', `\u2713 Alert ${alert.alert_id} indexed \u2014 agents engaging`);
  } catch (err) {
    log.error(`Alert injection failed: ${err.message}`);
    dashboard.addActivity('system', `\u2717 Alert injection failed: ${err.message}`);
    dashboard.stop();
    throw new Error('Scenario 3 aborted at alert injection');
  }

  if (skipVerify) {
    const injectTime = ((Date.now() - start) / 1000).toFixed(1);
    dashboard.addActivity('system', '--skip-verify: Skipping resolution polling.');
    dashboard.stop();
    return { success: true, duration: injectTime, verified: false };
  }

  // ── Wait for incident creation ─────────────────────────────────
  const incidentId = await waitForIncident(alert.alert_id, 30000);

  if (!incidentId) {
    dashboard.addActivity('system', '\u26A0 Timeout waiting for incident creation');
    dashboard.stop();
    return { success: true, duration: ((Date.now() - start) / 1000).toFixed(1), verified: false };
  }

  // Tell mock workflow handlers NOT to auto-inject healthy metrics.
  // This scenario controls its own metrics to force a reflection loop.
  // Brief delay to let the delegation's initial writes (incident status, etc.) settle
  // before we write to the same document — avoids Elasticsearch version conflicts.
  await new Promise(r => setTimeout(r, 3000));
  try {
    await client.update({
      index: 'vigil-incidents',
      id: incidentId,
      doc: { suppress_health_injection: true, approval_status: 'approved', approval_method: 'auto' },
      retry_on_conflict: 5
    });
    dashboard.addActivity('system', 'Suppress flag set \u2014 mock handlers will not auto-inject healthy metrics');
  } catch (err) {
    log.warn(`Could not set suppress flag: ${err.message}`);
  }

  startPolling(incidentId, dashboard);

  // ── Wave 2: After first verification — still failing ───────────
  // Wait for the incident to reach 'verifying' (Pass 1).
  // The verifier has a 10s stabilization wait — inject bad metrics immediately
  // so the health query finds them.
  dashboard.addActivity('system', 'Waiting for first verification attempt...');
  const reachedVerifying = await waitForIncidentStatus(incidentId, 'verifying', 180000);

  if (reachedVerifying) {
    dashboard.addActivity('system', '\u2500\u2500\u2500\u2500 Injecting post-restart metrics (still failing) \u2500\u2500\u2500\u2500');
    const n = await injectMetrics('order-service', { count: 500, errorRate: 0.38, timespanMinutes: 5 });
    dashboard.addActivity('system', `\u2713 ${n} metric events injected (38% error rate \u2014 still failing)`);
  }

  // ── Wave 3: Timed injection — swap bad metrics for good ones ────────
  // Strategy: after injecting Wave 2, wait 15s so the first verifier's health
  // check (at ~10s into stabilization) sees the bad data and fails. Then
  // immediately swap in good metrics BEFORE the reflection loop's second
  // verification runs. This avoids the race condition of trying to detect
  // transient states like 'reflecting' or 'investigating' via polling.
  dashboard.addActivity('system', 'Waiting 15s for first verification to complete...');
  await new Promise(r => setTimeout(r, 15_000));

  dashboard.addActivity('system', '\u2500\u2500\u2500\u2500 Injecting post-hotfix metrics (recovering) \u2500\u2500\u2500\u2500');

  // Clear suppress flag so mock handlers also inject healthy metrics during Pass 2
  try {
    await client.update({
      index: 'vigil-incidents',
      id: incidentId,
      doc: { suppress_health_injection: false },
      retry_on_conflict: 5
    });
  } catch (err) {
    log.warn(`Could not clear suppress flag: ${err.message}`);
  }

  // Purge Wave 2 bad metrics and inject clean ones
  try {
    const delResult = await client.deleteByQuery({
      index: 'vigil-metrics-default',
      query: { term: { 'service.name.keyword': 'order-service' } },
      refresh: true,
      conflicts: 'proceed'
    });
    log.info(`Deleted ${delResult.deleted || 0} stale metric docs for order-service`);
  } catch (delErr) {
    log.warn(`deleteByQuery failed (best effort): ${delErr.message}`);
  }
  const goodN = await injectMetrics('order-service', { count: 2000, errorRate: 0.004, timespanMinutes: 5 });
  dashboard.addActivity('system', `\u2713 ${goodN} metric events injected (0.4% error rate \u2014 recovered)`);

  // ── Wait for final resolution (poller handles dashboard update) ─
  const incident = await waitForResolution({ timeoutMs: 300_000, intervalMs: 10_000 });
  const totalTime = ((Date.now() - start) / 1000).toFixed(1);

  // Stop if poller didn't already
  stopPolling();
  dashboard.stop();

  if (incident) {
    return { success: true, duration: totalTime, verified: true, incident };
  }

  return { success: true, duration: totalTime, verified: false };
}

// Self-execute when run directly
const thisFile = resolve(fileURLToPath(import.meta.url));
const entryFile = resolve(process.argv[1]);

if (thisFile === entryFile) {
  runReflectionLoop()
    .then(result => {
      console.log('Reflection Loop finished:', result.verified ? 'VERIFIED' : 'INJECT ONLY');
    })
    .catch(err => {
      log.error(err.message);
      process.exitCode = 1;
    });
}
