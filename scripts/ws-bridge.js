#!/usr/bin/env node

/**
 * WebSocket bridge server for Vigil UI.
 * Polls Elasticsearch for changes and broadcasts WebSocketEvents to connected clients.
 *
 * Usage: node scripts/ws-bridge.js
 *   Runs on port 3000, serves WebSocket at /ws/vigil
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { Client } from '@elastic/elasticsearch';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('ws-bridge');

// ── Config ──────────────────────────────────────────────────────
const PORT = parseInt(process.env.WS_PORT || '3000', 10);
const POLL_INTERVAL = parseInt(process.env.WS_POLL_INTERVAL || '2000', 10);
const ES_URL = process.env.ELASTIC_URL;
const ES_KEY = process.env.ELASTIC_API_KEY;

if (!ES_URL || !ES_KEY) {
  log.error('Set ELASTIC_URL and ELASTIC_API_KEY environment variables');
  process.exit(1);
}

const es = new Client({ node: ES_URL, auth: { apiKey: ES_KEY } });

// ── State tracking for change detection ─────────────────────────
let lastIncidentCheck = new Date().toISOString();
let lastTelemetryCheck = new Date().toISOString();
let knownIncidents = new Map(); // id → { status, updated_at }

// ── HTTP + WebSocket server ─────────────────────────────────────
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: wss.clients.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/ws/vigil' });

function broadcast(event) {
  const msg = JSON.stringify(event);
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
      sent++;
    }
  }
  return sent;
}

wss.on('connection', (ws) => {
  log.info(`Client connected (total: ${wss.clients.size})`);
  ws.on('close', () => log.info(`Client disconnected (total: ${wss.clients.size})`));
});

// ── ES polling: Incidents ───────────────────────────────────────
async function pollIncidents() {
  try {
    const result = await es.search({
      index: 'vigil-incidents',
      size: 50,
      sort: [{ updated_at: 'desc' }],
      query: { range: { updated_at: { gte: lastIncidentCheck } } },
    });

    const hits = result.hits.hits;
    if (hits.length === 0) return;

    lastIncidentCheck = new Date().toISOString();

    for (const hit of hits) {
      const s = hit._source;
      const id = s.incident_id;
      const known = knownIncidents.get(id);

      // Map ES doc to UI Incident shape (minimal for WS events)
      const incident = mapIncidentForWS(s);

      if (!known) {
        // New incident
        broadcast({ type: 'incident.created', data: incident });
        knownIncidents.set(id, { status: s.status, updated_at: s.updated_at });
        log.info(`📢 incident.created: ${id}`);
      } else if (known.status !== s.status) {
        // Status changed
        broadcast({
          type: 'incident.state_changed',
          data: { id: incident.id, old_status: known.status, new_status: s.status, incident },
        });
        knownIncidents.set(id, { status: s.status, updated_at: s.updated_at });
        log.info(`📢 incident.state_changed: ${id} ${known.status} → ${s.status}`);
      } else if (known.updated_at !== s.updated_at) {
        // Other update
        broadcast({ type: 'incident.updated', data: incident });
        knownIncidents.set(id, { status: s.status, updated_at: s.updated_at });
      }
    }
  } catch (e) {
    log.warn(`Incident poll failed: ${e.message}`);
  }
}

function mapIncidentForWS(s) {
  const timestamps = s._state_timestamps || {};
  return {
    id: s.incident_id,
    status: s.status,
    severity: s.severity,
    type: s.incident_type || 'security',
    title: s.investigation_summary?.slice(0, 100) || `Incident ${s.incident_id}`,
    priority_score: s.priority_score || 0,
    created_at: s.created_at,
    updated_at: s.updated_at,
    resolved_at: s.resolved_at,
    affected_assets: (s.affected_assets || []).map((a) => ({
      asset_id: a.asset_id || '',
      asset_name: a.name || a.asset_name || '',
      asset_type: a.asset_type || 'host',
      criticality: a.criticality || 'tier-2',
      impact_type: a.impact_type || 'primary',
      confidence: a.confidence || 0.8,
    })),
    reflection_count: s.reflection_count || 0,
    current_agent: s.current_agent,
    _state_timestamps: timestamps,
  };
}

// ── ES polling: Agent telemetry ─────────────────────────────────
async function pollTelemetry() {
  try {
    const result = await es.search({
      index: 'vigil-agent-telemetry',
      size: 20,
      sort: [{ '@timestamp': 'desc' }],
      query: { range: { '@timestamp': { gt: lastTelemetryCheck } } },
    });

    const hits = result.hits.hits;
    if (hits.length === 0) return;

    lastTelemetryCheck = new Date().toISOString();

    // Broadcast newest first (reverse since sorted desc)
    for (const hit of hits.reverse()) {
      const s = hit._source;
      const entry = {
        id: hit._id,
        timestamp: s['@timestamp'] || s.timestamp || '',
        agent_name: s.agent_name || 'vigil-coordinator',
        action_type: s.action_type || s.tool_name || 'tool_call',
        action_detail: s.detail || s.tool_name || s.action_type || s.agent_name || '',
        incident_id: s.incident_id,
        execution_status: s.status || 'completed',
        duration_ms: s.duration_ms || s.execution_time_ms,
      };
      broadcast({ type: 'agent.activity', data: entry });
    }

    if (hits.length > 0) {
      log.info(`📢 agent.activity: ${hits.length} new entries`);
    }
  } catch (e) {
    log.warn(`Telemetry poll failed: ${e.message}`);
  }
}

// ── ES polling: Metrics snapshot ────────────────────────────────
let lastMetricsBroadcast = 0;
const METRICS_INTERVAL = 5000; // Broadcast metrics every 5s

async function pollMetrics() {
  if (Date.now() - lastMetricsBroadcast < METRICS_INTERVAL) return;
  lastMetricsBroadcast = Date.now();

  try {
    // Active incidents count
    const activeResult = await es.count({
      index: 'vigil-incidents',
      query: {
        bool: { must_not: [{ terms: { status: ['resolved', 'suppressed', 'escalated'] } }] },
      },
    });

    // MTTR
    const resolvedResult = await es.search({
      index: 'vigil-incidents',
      size: 0,
      query: { term: { status: 'resolved' } },
      aggs: { avg_duration: { avg: { field: 'total_duration_seconds' } } },
    });

    // Suppressed today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    let suppressedCount = 0;
    try {
      const suppressed = await es.count({
        index: 'vigil-alerts-*',
        query: {
          bool: {
            must: [{ range: { '@timestamp': { gte: startOfDay.toISOString() } } }],
            filter: [{ term: { 'triage_disposition.keyword': 'suppress' } }],
          },
        },
      });
      suppressedCount = suppressed.count;
    } catch { /* index may not exist */ }

    // Reflections
    const reflResult = await es.search({
      index: 'vigil-incidents',
      size: 0,
      aggs: { total: { sum: { field: 'reflection_count' } } },
    });

    const aggs = resolvedResult.aggregations;
    const reflAggs = reflResult.aggregations;

    const snapshot = {
      active_incidents: activeResult.count,
      mttr_last_24h_seconds: Math.round(aggs?.avg_duration?.value ?? 0),
      alerts_suppressed_today: suppressedCount,
      reflection_loops_triggered: reflAggs?.total?.value ?? 0,
      sparklines: { active_incidents: [], mttr: [], suppressed: [], reflections: [] },
    };

    broadcast({ type: 'metrics.updated', data: snapshot });
  } catch (e) {
    log.warn(`Metrics poll failed: ${e.message}`);
  }
}

// ── Bootstrap: Load known incidents ─────────────────────────────
async function bootstrap() {
  try {
    const result = await es.search({
      index: 'vigil-incidents',
      size: 100,
      _source: ['incident_id', 'status', 'updated_at'],
    });
    for (const hit of result.hits.hits) {
      const s = hit._source;
      knownIncidents.set(s.incident_id, { status: s.status, updated_at: s.updated_at });
    }
    log.info(`Bootstrapped ${knownIncidents.size} known incidents`);
  } catch (e) {
    log.warn(`Bootstrap failed: ${e.message}`);
  }
}

// ── Main loop ───────────────────────────────────────────────────
async function poll() {
  if (wss.clients.size === 0) return; // No clients, skip polling
  await Promise.allSettled([pollIncidents(), pollTelemetry(), pollMetrics()]);
}

async function start() {
  await bootstrap();

  server.listen(PORT, () => {
    log.info(`🔌 WebSocket bridge running on ws://localhost:${PORT}/ws/vigil`);
    log.info(`   Polling ES every ${POLL_INTERVAL}ms`);
    log.info(`   Health check: http://localhost:${PORT}/health`);
  });

  setInterval(poll, POLL_INTERVAL);
}

start().catch((e) => {
  log.error(`Failed to start WS bridge: ${e.message}`);
  process.exit(1);
});
