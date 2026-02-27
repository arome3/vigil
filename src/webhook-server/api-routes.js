// Express API routes — serves live Elasticsearch data to the Next.js UI.
//
// All routes are GET endpoints mounted under /api/vigil/*.
// Each route queries Elasticsearch and transforms results to match
// the UI TypeScript types (see ui/src/types/).

import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const router = Router();
const log = createLogger('api-routes');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Agent config loading (once at import time) ─────────────────────

const AGENT_DIRS = [
  'coordinator', 'triage', 'investigator', 'threat-hunter', 'sentinel',
  'commander', 'executor', 'verifier', 'analyst', 'reporter', 'chat',
];

const AGENT_CONFIGS = loadAgentConfigs();

function loadAgentConfigs() {
  const agentsRoot = join(__dirname, '..', 'agents');
  const configs = {};
  for (const dir of AGENT_DIRS) {
    try {
      const raw = readFileSync(join(agentsRoot, dir, 'config.json'), 'utf8');
      const cfg = JSON.parse(raw);
      configs[cfg.name] = cfg;
    } catch {
      // Agent directory missing — skip silently
    }
  }
  return configs;
}

// ─── Transform helpers ──────────────────────────────────────────────

function mapIncident(source) {
  const hasTimingData = source.ttd_seconds != null || source.tti_seconds != null
    || source.ttr_seconds != null || source.ttv_seconds != null
    || source.total_duration_seconds != null;

  const result = {
    id: source.incident_id,
    status: source.status,
    severity: source.severity || 'medium',
    type: source.incident_type || 'security',
    title: source.title || deriveTitle(source),
    priority_score: source.priority_score ?? 0,
    created_at: source.created_at,
    updated_at: source.updated_at,
    affected_assets: (source.affected_assets || []).map(mapBlastRadiusEntry),
    reflection_count: source.reflection_count || 0,
  };

  if (source.resolved_at) result.resolved_at = source.resolved_at;

  if (hasTimingData) {
    result.timing_metrics = {
      time_to_detect_seconds: source.ttd_seconds ?? 0,
      time_to_investigate_seconds: source.tti_seconds ?? 0,
      time_to_remediate_seconds: source.ttr_seconds ?? 0,
      time_to_verify_seconds: source.ttv_seconds ?? 0,
      total_duration_seconds: source.total_duration_seconds ?? 0,
    };
  }

  // Build investigation object from inline report or summary
  if (source.investigation_summary || source.investigation_report) {
    const report = source.investigation_report || {};
    result.investigation = {
      investigation_id: report.investigation_id || source.incident_id,
      root_cause: source.investigation_summary || '',
      attack_chain: (report.attack_chain || []).map(mapAttackChainEntry),
      blast_radius: (report.blast_radius || []).map(mapBlastRadiusEntry),
      mitre_techniques: extractMitreTechniques(report.attack_chain),
      recommended_next: report.recommended_next || 'plan_remediation',
    };
    if (report.change_correlation) {
      result.investigation.change_correlation = report.change_correlation;
    }
  }

  if (source.remediation_plan) result.remediation_plan = source.remediation_plan;

  // Surface the last verification result
  if (source.verification_results?.length > 0) {
    result.verification = source.verification_results[source.verification_results.length - 1];
  }

  if (source.external_links) result.external_links = source.external_links;

  // current_agent = last element of agents_involved
  if (source.agents_involved?.length > 0) {
    result.current_agent = source.agents_involved[source.agents_involved.length - 1];
  }

  if (source._state_timestamps) result._state_timestamps = source._state_timestamps;

  return result;
}

function deriveTitle(source) {
  const sev = capitalize(source.severity || 'unknown');
  const type = source.incident_type === 'operational'
    ? 'Operational Incident'
    : 'Security Incident';
  return `${sev} ${type}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function mapAttackChainEntry(entry, index) {
  return {
    step: entry.step ?? index + 1,
    technique_id: entry.technique_id || '',
    technique_name: entry.technique_name || '',
    tactic: entry.tactic || '',
    source: entry.source || '',
    target: entry.target || '',
    confidence: entry.confidence ?? 0,
    evidence_count: entry.evidence_count ?? (entry.evidence ? 1 : 0),
  };
}

function mapBlastRadiusEntry(entry) {
  return {
    asset_id: entry.asset_id || '',
    asset_name: entry.asset_name || entry.name || '',
    asset_type: entry.asset_type || entry.type || 'unknown',
    criticality: entry.criticality || 'tier-3',
    impact_type: entry.impact_type || 'unknown',
    confidence: entry.confidence ?? 0,
  };
}

function extractMitreTechniques(attackChain) {
  if (!attackChain) return [];
  return [...new Set(attackChain.map(e => e.technique_id).filter(Boolean))];
}

function mapTelemetryStatus(status) {
  if (status === 'success') return 'completed';
  if (status === 'failure' || status === 'timeout') return 'failed';
  return 'in_progress';
}

function mapLearningStatus(source) {
  if (source.review_status === 'approved' || source.applied) return 'applied';
  if (source.review_status === 'rejected') return 'rejected';
  return 'pending';
}

function computeTrend(current, previous) {
  if (previous === 0 && current === 0) return 'stable';
  if (current > previous * 1.1) return 'up';
  if (current < previous * 0.9) return 'down';
  return 'stable';
}

/** Extract a 24-element sparkline array from date_histogram buckets. */
function extractSparkline(buckets, valueField) {
  const arr = new Array(24).fill(0);
  if (!buckets) return arr;
  const now = Date.now();
  for (const b of buckets) {
    const t = typeof b.key === 'number' ? b.key : new Date(b.key_as_string).getTime();
    const idx = 23 - Math.floor((now - t) / 3_600_000);
    if (idx >= 0 && idx < 24) {
      arr[idx] = valueField ? (b[valueField]?.value ?? 0) : b.doc_count;
    }
  }
  return arr;
}

/** Safely navigate into a fulfilled PromiseSettledResult. */
function settled(result) {
  return result.status === 'fulfilled' ? result.value : null;
}

/** True when an ES error is index_not_found (index hasn't been created yet). */
function isIndexNotFound(err) {
  return err.meta?.statusCode === 404;
}

// ─── 1. GET /api/vigil/incidents ─────────────────────────────────────

router.get('/api/vigil/incidents', async (_req, res) => {
  try {
    const result = await client.search({
      index: 'vigil-incidents',
      size: 50,
      sort: [{ created_at: 'desc' }],
      query: { match_all: {} },
    });

    const incidents = (result.hits?.hits || []).map(hit => mapIncident(hit._source));
    res.json(incidents);
  } catch (err) {
    if (isIndexNotFound(err)) { res.json([]); return; }
    log.error(`GET /incidents failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 2. GET /api/vigil/incidents/:id ─────────────────────────────────

router.get('/api/vigil/incidents/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [incidentResult, investigationResult] = await Promise.allSettled([
      client.search({
        index: 'vigil-incidents',
        size: 1,
        query: { term: { incident_id: id } },
      }),
      client.search({
        index: 'vigil-investigations',
        size: 1,
        sort: [{ created_at: 'desc' }],
        query: { term: { incident_id: id } },
      }),
    ]);

    const incidentHit = settled(incidentResult)?.hits?.hits?.[0];

    if (!incidentHit) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }

    const incident = mapIncident(incidentHit._source);

    // Enrich with full investigation record when available
    const invHit = settled(investigationResult)?.hits?.hits?.[0];
    if (invHit) {
      const inv = invHit._source;
      incident.investigation = {
        investigation_id: inv.investigation_id || inv.incident_id,
        root_cause: inv.root_cause || incident.investigation?.root_cause || '',
        attack_chain: (inv.attack_chain || []).map(mapAttackChainEntry),
        blast_radius: (inv.blast_radius || []).map(mapBlastRadiusEntry),
        change_correlation: inv.change_correlation,
        mitre_techniques: extractMitreTechniques(inv.attack_chain),
        recommended_next: inv.recommended_next || 'plan_remediation',
      };
    }

    res.json(incident);
  } catch (err) {
    log.error(`GET /incidents/:id failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 3. GET /api/vigil/agents ────────────────────────────────────────

router.get('/api/vigil/agents', async (_req, res) => {
  try {
    const result = await client.search({
      index: 'vigil-agent-telemetry',
      size: 0,
      query: { range: { '@timestamp': { gte: 'now-24h' } } },
      aggs: {
        by_agent: {
          terms: { field: 'agent_name', size: 20 },
          aggs: {
            avg_exec_time: { avg: { field: 'execution_time_ms' } },
            latest: {
              top_hits: {
                size: 1,
                sort: [{ '@timestamp': 'desc' }],
                _source: ['status'],
              },
            },
          },
        },
      },
    });

    const buckets = result.aggregations?.by_agent?.buckets || [];
    const telemetryMap = {};
    for (const bucket of buckets) {
      const latestHit = bucket.latest?.hits?.hits?.[0];
      telemetryMap[bucket.key] = {
        tool_calls_today: bucket.doc_count,
        avg_execution_time_ms: Math.round(bucket.avg_exec_time?.value || 0),
        latest_status: latestHit?._source?.status || 'success',
      };
    }

    const agents = Object.values(AGENT_CONFIGS).map(config => {
      const telemetry = telemetryMap[config.name] || {};
      let status = 'idle';
      if (telemetry.latest_status === 'failure') status = 'error';
      else if (telemetry.tool_calls_today > 0) status = 'active';

      return {
        name: config.name,
        description: config.description,
        status,
        tools: config.tools || [],
        a2a_connections: config.a2a_connections || [],
        tool_calls_today: telemetry.tool_calls_today || 0,
        avg_execution_time_ms: telemetry.avg_execution_time_ms || 0,
      };
    });

    res.json(agents);
  } catch (err) {
    log.error(`GET /agents failed: ${err.message}`);
    // Graceful degradation — return static metadata with zero telemetry
    const agents = Object.values(AGENT_CONFIGS).map(config => ({
      name: config.name,
      description: config.description,
      status: 'idle',
      tools: config.tools || [],
      a2a_connections: config.a2a_connections || [],
      tool_calls_today: 0,
      avg_execution_time_ms: 0,
    }));
    res.json(agents);
  }
});

// ─── 4. GET /api/vigil/metrics ───────────────────────────────────────
//
// Consolidates 4 ES queries (one per source index) to build the full
// DashboardMetrics response including current values, sparklines, and
// trend directions.

router.get('/api/vigil/metrics', async (_req, res) => {
  try {
    const [activeCountResult, resolvedResult, alertsResult, createdResult] =
      await Promise.allSettled([
        // (A) Active incidents — current count (status-based, not time-based)
        client.count({
          index: 'vigil-incidents',
          query: {
            bool: {
              must_not: [{ terms: { status: ['resolved', 'suppressed'] } }],
            },
          },
        }),

        // (B) Resolved incidents — MTTR + sparkline + trend (last 48h window)
        client.search({
          index: 'vigil-incidents',
          size: 0,
          query: {
            bool: {
              filter: [
                { term: { status: 'resolved' } },
                { range: { resolved_at: { gte: 'now-48h' } } },
              ],
            },
          },
          aggs: {
            current: {
              filter: { range: { resolved_at: { gte: 'now-24h' } } },
              aggs: {
                avg_duration: { avg: { field: 'total_duration_seconds' } },
                timeline: {
                  date_histogram: { field: 'resolved_at', fixed_interval: '1h' },
                  aggs: { avg_duration: { avg: { field: 'total_duration_seconds' } } },
                },
              },
            },
            previous: {
              filter: { range: { resolved_at: { gte: 'now-48h', lt: 'now-24h' } } },
              aggs: { avg_duration: { avg: { field: 'total_duration_seconds' } } },
            },
          },
        }),

        // (C) Alerts — total + suppressed + sparkline + trend (last 48h window)
        client.search({
          index: 'vigil-alerts-default',
          size: 0,
          query: { range: { '@timestamp': { gte: 'now-48h' } } },
          aggs: {
            current_total: {
              filter: { range: { '@timestamp': { gte: 'now-24h' } } },
            },
            current_suppressed: {
              filter: {
                bool: {
                  filter: [
                    { range: { '@timestamp': { gte: 'now-24h' } } },
                    { term: { 'triage.disposition': 'suppress' } },
                  ],
                },
              },
              aggs: {
                timeline: {
                  date_histogram: { field: '@timestamp', fixed_interval: '1h' },
                },
              },
            },
            previous_suppressed: {
              filter: {
                bool: {
                  filter: [
                    { range: { '@timestamp': { gte: 'now-48h', lt: 'now-24h' } } },
                    { term: { 'triage.disposition': 'suppress' } },
                  ],
                },
              },
            },
          },
        }),

        // (D) Incidents created — active sparkline + reflections + trends (last 48h)
        client.search({
          index: 'vigil-incidents',
          size: 0,
          query: { range: { created_at: { gte: 'now-48h' } } },
          aggs: {
            current: {
              filter: { range: { created_at: { gte: 'now-24h' } } },
              aggs: {
                reflections: { sum: { field: 'reflection_count' } },
                timeline: {
                  date_histogram: { field: 'created_at', fixed_interval: '1h' },
                  aggs: { reflections: { sum: { field: 'reflection_count' } } },
                },
              },
            },
            previous: {
              filter: { range: { created_at: { gte: 'now-48h', lt: 'now-24h' } } },
              aggs: { reflections: { sum: { field: 'reflection_count' } } },
            },
          },
        }),
      ]);

    // Extract values with safe fallbacks
    const activeIncidents = settled(activeCountResult)?.count ?? 0;

    const resolved = settled(resolvedResult);
    const mttr = resolved?.aggregations?.current?.avg_duration?.value ?? 0;
    const prevMttr = resolved?.aggregations?.previous?.avg_duration?.value ?? 0;

    const alerts = settled(alertsResult);
    const alertsTotal = alerts?.aggregations?.current_total?.doc_count ?? 0;
    const suppressed = alerts?.aggregations?.current_suppressed?.doc_count ?? 0;
    const prevSuppressed = alerts?.aggregations?.previous_suppressed?.doc_count ?? 0;

    const created = settled(createdResult);
    const reflections = created?.aggregations?.current?.reflections?.value ?? 0;
    const prevReflections = created?.aggregations?.previous?.reflections?.value ?? 0;
    const currentCreated = created?.aggregations?.current?.doc_count ?? 0;
    const prevCreated = created?.aggregations?.previous?.doc_count ?? 0;

    res.json({
      active_incidents: activeIncidents,
      mttr_last_24h_seconds: Math.round(mttr),
      alerts_suppressed_today: suppressed,
      alerts_total_today: alertsTotal,
      reflection_loops_triggered: reflections,
      sparklines: {
        active_incidents: extractSparkline(
          created?.aggregations?.current?.timeline?.buckets,
        ),
        mttr: extractSparkline(
          resolved?.aggregations?.current?.timeline?.buckets,
          'avg_duration',
        ),
        suppressed: extractSparkline(
          alerts?.aggregations?.current_suppressed?.timeline?.buckets,
        ),
        reflections: extractSparkline(
          created?.aggregations?.current?.timeline?.buckets,
          'reflections',
        ),
      },
      trends: {
        active_incidents: computeTrend(currentCreated, prevCreated),
        mttr: computeTrend(mttr, prevMttr),
        suppressed: computeTrend(suppressed, prevSuppressed),
        reflections: computeTrend(reflections, prevReflections),
      },
    });
  } catch (err) {
    log.error(`GET /metrics failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 5. GET /api/vigil/health ────────────────────────────────────────

router.get('/api/vigil/health', async (_req, res) => {
  try {
    const [baselinesResult, metricsResult] = await Promise.allSettled([
      client.search({
        index: 'vigil-baselines',
        size: 100,
        query: { match_all: {} },
      }),
      client.search({
        index: 'vigil-metrics-default',
        size: 0,
        query: { range: { '@timestamp': { gte: 'now-5m' } } },
        aggs: {
          by_service: {
            terms: { field: 'service_name', size: 20 },
            aggs: {
              by_metric: {
                terms: { field: 'metric_name', size: 10 },
                aggs: { avg_value: { avg: { field: 'value' } } },
              },
            },
          },
        },
      }),
    ]);

    // Baseline map: service → metric → { mean, stddev }
    const baselineMap = {};
    if (baselinesResult.status === 'fulfilled') {
      for (const hit of (baselinesResult.value.hits?.hits || [])) {
        const s = hit._source;
        if (!baselineMap[s.service_name]) baselineMap[s.service_name] = {};
        baselineMap[s.service_name][s.metric_name] = {
          mean: s.avg_value || 0,
          stddev: s.stddev_value || 1,
        };
      }
    }

    // Current metrics map: service → metric → value
    const currentMap = {};
    if (metricsResult.status === 'fulfilled') {
      const svcBuckets = metricsResult.value.aggregations?.by_service?.buckets || [];
      for (const svc of svcBuckets) {
        currentMap[svc.key] = {};
        for (const m of (svc.by_metric?.buckets || [])) {
          currentMap[svc.key][m.key] = m.avg_value?.value || 0;
        }
      }
    }

    const services = [...new Set(Object.keys(baselineMap))];
    const health = services.map(service => {
      const baselines = baselineMap[service] || {};
      const current = currentMap[service] || {};

      const point = (metricName) => {
        const bl = baselines[metricName] || { mean: 0, stddev: 1 };
        const cur = current[metricName] ?? bl.mean;
        const stddev = bl.stddev || 1;
        return {
          current: cur,
          baseline_mean: bl.mean,
          baseline_stddev: bl.stddev,
          deviation_sigma: Number(((cur - bl.mean) / stddev).toFixed(2)),
        };
      };

      return {
        service_name: service,
        metrics: {
          latency: point('latency'),
          error_rate: point('error_rate'),
          throughput: point('throughput'),
        },
      };
    });

    res.json(health);
  } catch (err) {
    log.error(`GET /health failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 6. GET /api/vigil/activity ──────────────────────────────────────

router.get('/api/vigil/activity', async (_req, res) => {
  try {
    const result = await client.search({
      index: 'vigil-agent-telemetry',
      size: 50,
      sort: [{ '@timestamp': 'desc' }],
      query: { match_all: {} },
    });

    const activities = (result.hits?.hits || []).map(hit => {
      const s = hit._source;
      return {
        id: hit._id,
        timestamp: s['@timestamp'],
        agent_name: s.agent_name,
        action_type: s.tool_name || s.tool_type || 'unknown',
        action_detail: s.action_detail || `${s.tool_name || 'action'} (${s.status})`,
        incident_id: s.incident_id || undefined,
        execution_status: mapTelemetryStatus(s.status),
        duration_ms: s.execution_time_ms || undefined,
      };
    });

    res.json(activities);
  } catch (err) {
    if (isIndexNotFound(err)) { res.json([]); return; }
    log.error(`GET /activity failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 7. GET /api/vigil/learning ──────────────────────────────────────

router.get('/api/vigil/learning', async (_req, res) => {
  try {
    const result = await client.search({
      index: 'vigil-learnings',
      size: 50,
      sort: [{ created_at: 'desc' }],
      query: { match_all: {} },
    });

    const learnings = (result.hits?.hits || []).map(hit => {
      const s = hit._source;
      return {
        id: hit._id,
        type: s.learning_type || s.type || 'retrospective',
        status: mapLearningStatus(s),
        title: s.title || s.summary || 'Untitled learning',
        description: s.description || s.summary || '',
        confidence: s.confidence ?? 0,
        incident_id: (s.incident_ids || [])[0] || s.incident_id || '',
        created_at: s.created_at || s['@timestamp'],
        applied_at: s.applied_at || undefined,
        analysis: s.data || {},
      };
    });

    res.json(learnings);
  } catch (err) {
    if (isIndexNotFound(err)) { res.json([]); return; }
    log.error(`GET /learning failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── 8. GET /api/vigil/learning/retrospectives/:id ───────────────────

router.get('/api/vigil/learning/retrospectives/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.search({
      index: 'vigil-learnings',
      size: 1,
      query: {
        bool: {
          filter: [{ term: { learning_type: 'retrospective' } }],
          should: [
            { term: { _id: id } },
            { term: { incident_id: id } },
            { term: { incident_ids: id } },
          ],
          minimum_should_match: 1,
        },
      },
    });

    const hit = result.hits?.hits?.[0];
    if (!hit) {
      res.status(404).json({ error: 'Retrospective not found' });
      return;
    }

    const s = hit._source;
    const data = s.data || {};

    res.json({
      id: hit._id,
      incident_id: (s.incident_ids || [])[0] || s.incident_id || '',
      title: s.title || s.summary || 'Untitled Retrospective',
      created_at: s.created_at || s['@timestamp'],
      timeline_summary: data.timeline_summary || s.summary || '',
      total_duration_seconds: data.total_duration_seconds || 0,
      agent_performance: data.agent_performance || [],
      what_went_well: data.what_went_well || [],
      needs_improvement: data.needs_improvement || [],
      recommendations: data.recommendations || [],
    });
  } catch (err) {
    if (isIndexNotFound(err)) { res.status(404).json({ error: 'Retrospective not found' }); return; }
    log.error(`GET /learning/retrospectives/:id failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
