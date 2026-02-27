#!/usr/bin/env node

/**
 * Seed realistic dashboard data into Elasticsearch for the Vigil UI.
 * Populates: incidents, alerts, agent telemetry, service health metrics.
 *
 * Usage: node scripts/seed-dashboard-data.js [--clean]
 *   --clean   Delete existing seed data before inserting
 */

import { Client } from '@elastic/elasticsearch';
import { randomUUID } from 'crypto';

// ── Config ──────────────────────────────────────────────────────
const ES_URL = process.env.ELASTIC_URL;
const ES_KEY = process.env.ELASTIC_API_KEY;

if (!ES_URL || !ES_KEY) {
  console.error('Set ELASTIC_URL and ELASTIC_API_KEY environment variables');
  process.exit(1);
}

const client = new Client({ node: ES_URL, auth: { apiKey: ES_KEY } });

const CLEAN = process.argv.includes('--clean');
const NOW = Date.now();

function ago(hours, jitterMinutes = 0) {
  const ms = NOW - hours * 3600_000 - Math.random() * jitterMinutes * 60_000;
  return new Date(ms).toISOString();
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function incId() { return `INC-2026-${randomUUID().slice(0, 5).toUpperCase()}`; }
function alertId() { return `ALERT-${randomUUID().slice(0, 8).toUpperCase()}`; }

// ── Realistic data pools ────────────────────────────────────────
const SERVICES = ['order-service', 'payment-api', 'auth-gateway', 'user-service', 'notification-svc', 'inventory-mgr', 'api-gateway', 'search-service'];
const ASSETS = [
  { id: 'srv-payment-01', name: 'srv-payment-01', criticality: 'tier-1' },
  { id: 'api-gateway', name: 'api-gateway', criticality: 'tier-1' },
  { id: 'db-customers', name: 'db-customers', criticality: 'tier-1' },
  { id: 'user-service', name: 'user-service', criticality: 'tier-2' },
  { id: 'notification-svc', name: 'notification-svc', criticality: 'tier-3' },
  { id: 'search-service', name: 'search-service', criticality: 'tier-2' },
  { id: 'inventory-mgr', name: 'inventory-mgr', criticality: 'tier-2' },
  { id: 'cdn-edge-01', name: 'cdn-edge-01', criticality: 'tier-3' },
];
const AGENTS = ['vigil-coordinator', 'vigil-triage', 'vigil-investigator', 'vigil-threat-hunter', 'vigil-sentinel', 'vigil-commander', 'vigil-executor', 'vigil-verifier', 'vigil-analyst', 'vigil-reporter', 'vigil-chat'];
const TOOLS = ['vigil-esql-alert-enrichment', 'vigil-esql-service-health', 'vigil-dense-vector-search', 'vigil-threat-intel-lookup', 'vigil-esql-report-aggregate', 'vigil-wf-rotate-credentials', 'vigil-wf-restart-pods', 'vigil-wf-block-ip'];
const RULES = ['RULE-GEO-ANOMALY-001', 'RULE-BRUTE-FORCE-002', 'RULE-PRIV-ESC-003', 'RULE-DATA-EXFIL-004', 'RULE-LATERAL-005', 'RULE-CRED-STUFF-006', 'RULE-ANOMALOUS-DEPLOY-007'];
const RULE_NAMES = ['Geographic Anomaly — API Key from Unexpected Location', 'Brute Force — Multiple Failed Logins', 'Privilege Escalation Detected', 'Potential Data Exfiltration', 'Lateral Movement via SSH', 'Credential Stuffing Attack', 'Anomalous Deployment Pattern'];
const IPS = ['203.0.113.42', '198.51.100.77', '192.0.2.15', '10.0.1.55', '172.16.0.88', '45.33.32.156', '91.189.92.10', '104.248.50.87'];
const USERS = ['svc-payment', 'admin-deploy', 'api-service', 'root', 'deploy-bot', 'jenkins-ci', 'k8s-scheduler', 'ext-contractor'];
const MITRE = ['T1078', 'T1110', 'T1041', 'T1552', 'T1021', 'T1059', 'T1190', 'T1098'];

// ── Incident generation ─────────────────────────────────────────

function generateIncidents() {
  const incidents = [];

  // 5 resolved incidents (spread over last 24h, for MTTR)
  for (let i = 0; i < 5; i++) {
    const createdH = randInt(4, 22);
    const durationMin = randInt(3, 45);
    const createdAt = ago(createdH, 30);
    const resolvedAt = new Date(new Date(createdAt).getTime() + durationMin * 60_000).toISOString();
    const id = incId();
    const asset = pick(ASSETS);
    const sev = pick(['critical', 'high', 'medium']);
    const reflections = i < 2 ? randInt(1, 3) : 0; // 2 have reflection loops

    incidents.push({
      incident_id: id,
      status: 'resolved',
      severity: sev,
      incident_type: pick(['security', 'operational']),
      priority_score: +(Math.random() * 0.4 + 0.6).toFixed(2),
      created_at: createdAt,
      updated_at: resolvedAt,
      resolved_at: resolvedAt,
      alert_ids: [alertId()],
      agents_involved: ['vigil-triage', 'vigil-investigator', 'vigil-commander', 'vigil-executor', 'vigil-verifier'],
      affected_assets: [{ asset_id: asset.id, name: asset.name, criticality: asset.criticality, confidence: +(Math.random() * 0.2 + 0.8).toFixed(2) }],
      investigation_summary: pick([
        'Compromised API key used from anomalous geographic location',
        'Brute force attack targeting admin accounts detected and contained',
        'Unauthorized lateral movement via stolen SSH credentials',
        'Deployment rollback triggered after error rate spike',
        'Credential stuffing attack blocked at perimeter',
      ]),
      remediation_plan: {
        actions: [
          { order: 1, action_type: 'containment', description: 'Block source IP', target_system: 'firewall', approval_required: true, status: 'completed', execution_time_ms: randInt(200, 1500) },
          { order: 2, action_type: 'remediation', description: 'Rotate affected credentials', target_system: asset.name, approval_required: true, status: 'completed', execution_time_ms: randInt(500, 3000) },
        ],
        success_criteria: [
          { metric: 'error_rate', operator: 'lte', threshold: 0.02, service_name: pick(SERVICES) },
        ],
      },
      verification_results: [
        { iteration: 1, health_score: reflections > 0 ? 0.4 : 0.95, passed: reflections === 0, checked_at: resolvedAt, criteria_results: [{ metric: 'error_rate', current_value: reflections > 0 ? 0.05 : 0.01, threshold: 0.02, passed: reflections === 0 }] },
        ...(reflections > 0 ? [{ iteration: 2, health_score: 0.96, passed: true, checked_at: resolvedAt, criteria_results: [{ metric: 'error_rate', current_value: 0.008, threshold: 0.02, passed: true }] }] : []),
      ],
      reflection_count: reflections,
      resolution_type: 'auto_resolved',
      change_correlation: i < 2 ? {
        matched: true,
        commit_sha: randomUUID().slice(0, 7),
        commit_message: pick(['fix: update payment handler timeout', 'feat: add rate limiting to auth', 'chore: bump dependency versions']),
        commit_author: pick(['dev-alice', 'dev-bob', 'dev-carol']),
        pr_number: randInt(100, 999),
        time_gap_seconds: randInt(120, 3600),
        confidence: pick(['high', 'medium']),
      } : undefined,
      ttd_seconds: randInt(5, 30),
      tti_seconds: randInt(15, 120),
      ttr_seconds: randInt(30, 300),
      ttv_seconds: randInt(10, 60),
      total_duration_seconds: durationMin * 60,
      _state_timestamps: {
        detected: createdAt,
        triaged: new Date(new Date(createdAt).getTime() + 10_000).toISOString(),
        investigating: new Date(new Date(createdAt).getTime() + 30_000).toISOString(),
        planning: new Date(new Date(createdAt).getTime() + 120_000).toISOString(),
        executing: new Date(new Date(createdAt).getTime() + 180_000).toISOString(),
        verifying: new Date(new Date(createdAt).getTime() + 240_000).toISOString(),
        resolved: resolvedAt,
      },
    });
  }

  // 3 active incidents (in various pipeline stages)
  const activeStatuses = ['investigating', 'executing', 'awaiting_approval'];
  for (let i = 0; i < 3; i++) {
    const createdH = randInt(0, 3);
    const createdAt = ago(createdH, 20);
    const id = incId();
    const asset = pick(ASSETS);
    const status = activeStatuses[i];

    incidents.push({
      incident_id: id,
      status,
      severity: pick(['critical', 'high']),
      incident_type: 'security',
      priority_score: +(Math.random() * 0.3 + 0.7).toFixed(2),
      created_at: createdAt,
      updated_at: ago(0, 10),
      alert_ids: [alertId()],
      agents_involved: ['vigil-triage', 'vigil-investigator'],
      affected_assets: [{ asset_id: asset.id, name: asset.name, criticality: asset.criticality, confidence: +(Math.random() * 0.15 + 0.85).toFixed(2) }],
      investigation_summary: pick([
        'Active credential exfiltration detected — investigating blast radius',
        'Suspicious lateral movement between production zones',
        'Anomalous API key usage from unrecognized network',
      ]),
      reflection_count: 0,
      _state_timestamps: {
        detected: createdAt,
        triaged: new Date(new Date(createdAt).getTime() + 8_000).toISOString(),
        [status]: ago(0, 15),
      },
    });
  }

  // 2 suppressed incidents
  for (let i = 0; i < 2; i++) {
    const createdAt = ago(randInt(2, 18), 30);
    incidents.push({
      incident_id: incId(),
      status: 'suppressed',
      severity: 'low',
      incident_type: 'operational',
      priority_score: +(Math.random() * 0.3).toFixed(2),
      created_at: createdAt,
      updated_at: createdAt,
      alert_ids: [alertId()],
      agents_involved: ['vigil-triage'],
      affected_assets: [{ asset_id: pick(ASSETS).id, name: pick(ASSETS).name, criticality: 'tier-3', confidence: 0.6 }],
      investigation_summary: 'Known false positive — scheduled maintenance window',
      reflection_count: 0,
      resolution_type: 'suppressed',
      _state_timestamps: { detected: createdAt, suppressed: createdAt },
    });
  }

  return incidents;
}

// ── Alert generation ────────────────────────────────────────────

function generateAlerts(incidents) {
  const alerts = [];

  // Create alerts that map to incidents
  for (const inc of incidents) {
    for (const aid of inc.alert_ids) {
      const ruleIdx = randInt(0, RULES.length - 1);
      alerts.push({
        '@timestamp': inc.created_at,
        alert_id: aid,
        rule_id: RULES[ruleIdx],
        rule_name: RULE_NAMES[ruleIdx],
        severity_original: inc.severity,
        source: {
          ip: pick(IPS),
          geo: { country_iso_code: pick(['US', 'CN', 'RU', 'XX', 'DE', 'BR']), city_name: pick(['Portland', 'Unknown', 'Beijing', 'Moscow', 'Berlin']) },
          user_name: pick(USERS),
        },
        destination: { ip: pick(IPS), port: pick([443, 8080, 22, 3306, 5432]) },
        affected_asset: { id: inc.affected_assets[0].asset_id, name: inc.affected_assets[0].name, criticality: inc.affected_assets[0].criticality },
        enrichment: {
          correlated_event_count: randInt(1, 50),
          unique_destinations: randInt(1, 15),
          failed_auth_count: randInt(0, 200),
          priv_escalation_count: randInt(0, 5),
          risk_signal: +(Math.random() * 80 + 20).toFixed(1),
          historical_fp_rate: +(Math.random() * 0.3).toFixed(3),
          asset_criticality_score: inc.affected_assets[0].criticality === 'tier-1' ? 95 : inc.affected_assets[0].criticality === 'tier-2' ? 70 : 40,
        },
        triage: {
          priority_score: inc.priority_score,
          disposition: inc.status === 'suppressed' ? 'suppress' : 'investigate',
          suppression_reason: inc.status === 'suppressed' ? 'Known false positive — maintenance window' : undefined,
          triaged_at: new Date(new Date(inc.created_at).getTime() + 10_000).toISOString(),
          triaged_by: 'vigil-triage',
        },
        incident_id: inc.incident_id,
        triage_disposition: inc.status === 'suppressed' ? 'suppress' : 'investigate',
      });
    }
  }

  // Extra alerts without incidents (noise / queued)
  for (let i = 0; i < 20; i++) {
    const ts = ago(randInt(0, 23), 50);
    const ruleIdx = randInt(0, RULES.length - 1);
    const isSuppressed = i < 8;
    alerts.push({
      '@timestamp': ts,
      alert_id: alertId(),
      rule_id: RULES[ruleIdx],
      rule_name: RULE_NAMES[ruleIdx],
      severity_original: pick(['medium', 'low', 'high']),
      source: { ip: pick(IPS), user_name: pick(USERS) },
      affected_asset: { id: pick(ASSETS).id, name: pick(ASSETS).name, criticality: pick(['tier-1', 'tier-2', 'tier-3']) },
      triage: {
        priority_score: +(Math.random() * 0.5 + (isSuppressed ? 0 : 0.3)).toFixed(2),
        disposition: isSuppressed ? 'suppress' : 'queue',
        suppression_reason: isSuppressed ? pick(['Known scanner', 'Maintenance window', 'Duplicate alert', 'Low-risk automation']) : undefined,
        triaged_at: new Date(new Date(ts).getTime() + 5_000).toISOString(),
        triaged_by: 'vigil-triage',
      },
      triage_disposition: isSuppressed ? 'suppress' : 'queue',
    });
  }

  return alerts;
}

// ── Telemetry generation ────────────────────────────────────────

function generateTelemetry(incidents) {
  const entries = [];

  for (const inc of incidents) {
    const agentSeq = ['vigil-triage', 'vigil-investigator', 'vigil-threat-hunter', 'vigil-commander', 'vigil-executor', 'vigil-verifier'];
    let t = new Date(inc.created_at).getTime();

    for (const agent of agentSeq) {
      if (inc.status === 'suppressed' && agent !== 'vigil-triage') break;
      t += randInt(2000, 15000);
      entries.push({
        '@timestamp': new Date(t).toISOString(),
        agent_name: agent,
        incident_id: inc.incident_id,
        tool_name: pick(TOOLS),
        tool_type: pick(['esql', 'search', 'llm', 'workflow']),
        execution_time_ms: randInt(50, 2500),
        status: 'success',
        result_count: randInt(0, 20),
        detail: pick([
          'Enriched alert with correlated events',
          'Queried service health metrics via ES|QL',
          'Performed threat intel lookup for IOCs',
          'Searched similar incidents via dense vector',
          'Executed credential rotation workflow',
          'Verified service recovery metrics',
          'Generated remediation plan',
          'Assessed blast radius across assets',
        ]),
        action_type: 'tool_call',
        duration_ms: randInt(50, 2500),
      });

      // Some agents make multiple tool calls
      if (Math.random() > 0.5) {
        t += randInt(1000, 5000);
        entries.push({
          '@timestamp': new Date(t).toISOString(),
          agent_name: agent,
          incident_id: inc.incident_id,
          tool_name: pick(TOOLS),
          tool_type: pick(['esql', 'search', 'llm']),
          execution_time_ms: randInt(50, 1500),
          status: 'success',
          result_count: randInt(1, 10),
          detail: pick(['Follow-up enrichment query', 'Cross-referenced MITRE techniques', 'Validated containment scope', 'Checked deployment timeline']),
          action_type: 'tool_call',
          duration_ms: randInt(50, 1500),
        });
      }
    }
  }

  return entries;
}

// ── Service health metrics ──────────────────────────────────────

function generateHealthMetrics() {
  const ops = [];
  const services = SERVICES.slice(0, 6);

  // Generate metrics every 5 minutes for the last 2 hours
  for (let m = 120; m >= 0; m -= 5) {
    const ts = new Date(NOW - m * 60_000).toISOString();
    for (const svc of services) {
      // Base values per service (some services are healthier than others)
      const baseLatency = svc.includes('payment') ? 450 : svc.includes('auth') ? 200 : 150;
      const baseError = svc.includes('payment') ? 0.015 : 0.005;

      ops.push({ create: { _index: 'vigil-metrics-default' } });
      ops.push({
        '@timestamp': ts,
        'service.name': svc,
        'transaction.duration.us': (baseLatency + Math.random() * 100) * 1000,
        'event.outcome': Math.random() < baseError ? 'failure' : 'success',
      });

      // Multiple events per interval for realistic throughput
      for (let j = 0; j < randInt(3, 8); j++) {
        ops.push({ create: { _index: 'vigil-metrics-default' } });
        ops.push({
          '@timestamp': ts,
          'service.name': svc,
          'transaction.duration.us': (baseLatency + (Math.random() - 0.5) * 80) * 1000,
          'event.outcome': Math.random() < baseError ? 'failure' : 'success',
        });
      }
    }
  }

  return ops;
}

// ── Learning records ────────────────────────────────────────────

function generateLearningRecords(incidents) {
  const records = [];
  const resolved = incidents.filter(i => i.status === 'resolved');

  for (const inc of resolved.slice(0, 3)) {
    records.push({
      type: 'retrospective',
      status: 'applied',
      title: `Retrospective: ${inc.investigation_summary?.slice(0, 50)}`,
      description: `Post-incident analysis for ${inc.incident_id}`,
      confidence: +(Math.random() * 0.3 + 0.7).toFixed(2),
      incident_id: inc.incident_id,
      created_at: inc.resolved_at,
      applied_at: new Date(new Date(inc.resolved_at).getTime() + 60_000).toISOString(),
      timeline_summary: `Detection at T+0s, triage at T+10s, investigation complete at T+${inc.tti_seconds || 60}s, remediation at T+${inc.ttr_seconds || 120}s, verified at T+${inc.total_duration_seconds || 300}s.`,
      total_duration_seconds: inc.total_duration_seconds || 300,
      agent_performance: [
        { agent_name: 'vigil-triage', tools_called: randInt(2, 5), reasoning_time_ms: randInt(800, 3000), status: 'completed', accuracy_score: +(Math.random() * 0.15 + 0.85).toFixed(2) },
        { agent_name: 'vigil-investigator', tools_called: randInt(3, 8), reasoning_time_ms: randInt(2000, 8000), status: 'completed', accuracy_score: +(Math.random() * 0.2 + 0.8).toFixed(2) },
        { agent_name: 'vigil-commander', tools_called: randInt(1, 3), reasoning_time_ms: randInt(1000, 4000), status: 'completed' },
        { agent_name: 'vigil-verifier', tools_called: randInt(2, 4), reasoning_time_ms: randInt(500, 2000), status: 'completed', accuracy_score: +(Math.random() * 0.1 + 0.9).toFixed(2) },
      ],
      what_went_well: [
        'Fast triage — correct disposition within 10s',
        'Investigation identified root cause accurately',
        'Automated remediation completed without manual intervention',
      ],
      needs_improvement: [
        'Threat intel lookup had stale IOC data',
        'Blast radius assessment missed secondary asset',
      ],
      recommendations: [
        'Update threat intel feed refresh interval to 1h',
        'Add cross-zone asset dependency mapping',
        'Tune brute force detection threshold for service accounts',
      ],
      analysis: { root_cause_category: pick(['credential_compromise', 'misconfiguration', 'vulnerability_exploit']) },
    });
  }

  return records;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding Vigil dashboard data...\n');

  if (CLEAN) {
    console.log('🧹 Cleaning existing seed data...');
    for (const idx of ['vigil-incidents', 'vigil-agent-telemetry']) {
      try {
        await client.deleteByQuery({ index: idx, query: { match_all: {} }, refresh: true });
        console.log(`   ✓ Cleared ${idx}`);
      } catch { console.log(`   ⚠ ${idx} — skipped (may not exist)`); }
    }
    // Data streams need special handling
    for (const idx of ['vigil-alerts-default', 'vigil-metrics-default']) {
      try {
        await client.indices.delete({ index: idx });
        console.log(`   ✓ Deleted ${idx}`);
      } catch { console.log(`   ⚠ ${idx} — skipped`); }
    }
    for (const idx of ['vigil-learning-default', 'vigil-learnings']) {
      try {
        await client.deleteByQuery({ index: idx, query: { match_all: {} }, refresh: true });
        console.log(`   ✓ Cleared ${idx}`);
      } catch { console.log(`   ⚠ ${idx} — skipped`); }
    }
    console.log();
  }

  // Generate data
  const incidents = generateIncidents();
  const alerts = generateAlerts(incidents);
  const telemetry = generateTelemetry(incidents);
  const learningRecords = generateLearningRecords(incidents);

  // ── Index incidents ───────────────────────────────────────
  console.log(`📋 Indexing ${incidents.length} incidents...`);
  const incOps = incidents.flatMap(inc => [
    { index: { _index: 'vigil-incidents', _id: inc.incident_id } },
    inc,
  ]);
  const incResult = await client.bulk({ operations: incOps, refresh: 'wait_for' });
  console.log(`   ✓ ${incidents.length} incidents (${incidents.filter(i => i.status === 'resolved').length} resolved, ${incidents.filter(i => !['resolved', 'suppressed'].includes(i.status)).length} active, ${incidents.filter(i => i.status === 'suppressed').length} suppressed)`);
  if (incResult.errors) {
    const firstErr = incResult.items.find(i => i.index?.error);
    console.log(`   ⚠ Bulk errors — first: ${JSON.stringify(firstErr?.index?.error)}`);
  }

  // ── Index alerts ──────────────────────────────────────────
  console.log(`🚨 Indexing ${alerts.length} alerts...`);
  const alertOps = alerts.flatMap(a => [
    { create: { _index: 'vigil-alerts-default' } },
    a,
  ]);
  const alertResult = await client.bulk({ operations: alertOps, refresh: 'wait_for' });
  const suppressed = alerts.filter(a => a.triage_disposition === 'suppress').length;
  console.log(`   ✓ ${alerts.length} alerts (${suppressed} suppressed, ${alerts.length - suppressed} investigate/queue)`);
  if (alertResult.errors) {
    const firstErr = alertResult.items.find(i => i.create?.error);
    console.log(`   ⚠ Bulk errors — first: ${JSON.stringify(firstErr?.create?.error)}`);
  }

  // ── Index telemetry ───────────────────────────────────────
  console.log(`📡 Indexing ${telemetry.length} telemetry entries...`);
  const telOps = telemetry.flatMap(t => [
    { index: { _index: 'vigil-agent-telemetry' } },
    t,
  ]);
  const telResult = await client.bulk({ operations: telOps, refresh: 'wait_for' });
  console.log(`   ✓ ${telemetry.length} telemetry entries across ${new Set(telemetry.map(t => t.agent_name)).size} agents`);
  if (telResult.errors) {
    const firstErr = telResult.items.find(i => i.index?.error);
    console.log(`   ⚠ Bulk errors — first: ${JSON.stringify(firstErr?.index?.error)}`);
  }

  // ── Index service health metrics ──────────────────────────
  const healthOps = generateHealthMetrics();
  const metricCount = healthOps.length / 2;
  console.log(`💚 Indexing ${metricCount} service health metrics...`);
  // Bulk in chunks of 1000 ops
  for (let i = 0; i < healthOps.length; i += 1000) {
    const chunk = healthOps.slice(i, i + 1000);
    const res = await client.bulk({ operations: chunk, refresh: i + 1000 >= healthOps.length ? 'wait_for' : false });
    if (res.errors) {
      const firstErr = res.items.find(it => it.create?.error);
      console.log(`   ⚠ Chunk error: ${JSON.stringify(firstErr?.create?.error)}`);
    }
  }
  console.log(`   ✓ ${metricCount} metrics for ${SERVICES.slice(0, 6).join(', ')}`);

  // ── Index learning records ────────────────────────────────
  if (learningRecords.length > 0) {
    console.log(`📚 Indexing ${learningRecords.length} learning records...`);
    const learnOps = learningRecords.flatMap(r => [
      { index: { _index: 'vigil-learning-default' } },
      r,
    ]);
    const learnResult = await client.bulk({ operations: learnOps, refresh: 'wait_for' });
    console.log(`   ✓ ${learningRecords.length} learning records`);
    if (learnResult.errors) {
      const firstErr = learnResult.items.find(i => i.index?.error);
      console.log(`   ⚠ Bulk errors — first: ${JSON.stringify(firstErr?.index?.error)}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────
  const resolvedInc = incidents.filter(i => i.status === 'resolved');
  const avgMttr = resolvedInc.length > 0
    ? Math.round(resolvedInc.reduce((s, i) => s + i.total_duration_seconds, 0) / resolvedInc.length)
    : 0;
  const totalReflections = incidents.reduce((s, i) => s + i.reflection_count, 0);

  console.log('\n✅ Seed complete! Dashboard should now show:');
  console.log(`   Active Incidents:    ${incidents.filter(i => !['resolved', 'suppressed', 'escalated'].includes(i.status)).length}`);
  console.log(`   MTTR (resolved):     ~${Math.round(avgMttr / 60)}m (${resolvedInc.length} resolved)`);
  console.log(`   Alerts Suppressed:   ${suppressed} / ${alerts.length}`);
  console.log(`   Reflection Loops:    ${totalReflections}`);
  console.log(`   Services in Health:  ${SERVICES.slice(0, 6).length}`);
  console.log(`   Change Correlations: ${incidents.filter(i => i.change_correlation?.matched).length}`);
  console.log(`   Learning Records:    ${learningRecords.length}`);
  console.log('\n   Refresh http://localhost:3001 to see updated data.');
}

main().catch(e => { console.error('❌ Seed failed:', e.message); process.exit(1); });
