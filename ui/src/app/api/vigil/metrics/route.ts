import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { DashboardMetrics } from "@/types/metrics";

export const dynamic = "force-dynamic";

function deriveTrend(data: number[]): "up" | "down" | "stable" {
  if (data.length < 4) return "stable";
  const recent = data.slice(-3).reduce((a, b) => a + b, 0);
  const prior = data.slice(-6, -3).reduce((a, b) => a + b, 0);
  if (recent > prior * 1.2) return "up";
  if (recent < prior * 0.8) return "down";
  return "stable";
}

export async function GET() {
  try {
    // ── Core metric queries (parallel) ──────────────────────────
    const [activeResult, resolvedResult, reflectionResult] = await Promise.all([
      // Active (non-resolved, non-suppressed) incidents
      client.count({
        index: "vigil-incidents",
        query: {
          bool: {
            must_not: [
              { terms: { "status": ["resolved", "suppressed", "escalated"] } },
            ],
          },
        },
      }),
      // MTTR for resolved incidents — try total_duration_seconds first, fall back to scripted calc
      client.search({
        index: "vigil-incidents",
        size: 0,
        query: { term: { "status": "resolved" } },
        aggs: {
          avg_duration_field: {
            avg: { field: "total_duration_seconds" },
          },
          avg_duration_script: {
            avg: {
              script: {
                source:
                  "if (doc['resolved_at'].size() > 0 && doc['created_at'].size() > 0) { return (doc['resolved_at'].value.toInstant().toEpochMilli() - doc['created_at'].value.toInstant().toEpochMilli()) / 1000; } return 0;",
              },
            },
          },
        },
      }),
      // Total reflection loops
      client.search({
        index: "vigil-incidents",
        size: 0,
        aggs: { total_reflections: { sum: { field: "reflection_count" } } },
      }),
    ]);

    // Suppressed alerts today
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    let suppressedCount = 0;
    let totalAlertsToday = 0;
    try {
      const [suppressedResult, totalAlerts] = await Promise.all([
        client.count({
          index: "vigil-alerts-*",
          query: {
            bool: {
              must: [{ range: { "@timestamp": { gte: startOfDay } } }],
              filter: [{ term: { "triage_disposition.keyword": "suppress" } }],
            },
          },
        }),
        client.count({
          index: "vigil-alerts-*",
          query: { range: { "@timestamp": { gte: startOfDay } } },
        }),
      ]);
      suppressedCount = suppressedResult.count;
      totalAlertsToday = totalAlerts.count;
    } catch {
      // alerts index may not exist yet
    }

    // ── Sparkline data: hourly buckets over last 24h ────────────
    type HistBucket = { key_as_string: string; doc_count: number; reflections?: { value: number | null } };

    const [incidentTimeline, alertTimeline] = await Promise.allSettled([
      client.search({
        index: "vigil-incidents",
        size: 0,
        query: { range: { created_at: { gte: "now-24h" } } },
        aggs: {
          hourly: {
            date_histogram: { field: "created_at", fixed_interval: "1h", min_doc_count: 0, extended_bounds: { min: "now-24h", max: "now" } },
            aggs: {
              reflections: { sum: { field: "reflection_count" } },
            },
          },
        },
      }),
      client.search({
        index: "vigil-alerts-*",
        size: 0,
        query: { range: { "@timestamp": { gte: "now-24h" } } },
        aggs: {
          hourly: {
            date_histogram: { field: "@timestamp", fixed_interval: "1h", min_doc_count: 0, extended_bounds: { min: "now-24h", max: "now" } },
            aggs: {
              suppressed: { filter: { term: { "triage_disposition.keyword": "suppress" } } },
            },
          },
        },
      }),
    ]);

    // Extract incident sparkline (active incidents per hour)
    let incidentSparkline: number[] = [];
    let reflectionSparkline: number[] = [];
    if (incidentTimeline.status === "fulfilled") {
      const agg = incidentTimeline.value.aggregations as Record<string, { buckets: HistBucket[] }> | undefined;
      const buckets = agg?.hourly?.buckets ?? [];
      incidentSparkline = buckets.map((b) => b.doc_count);
      reflectionSparkline = buckets.map((b) => b.reflections?.value ?? 0);
    }

    // Extract alert/suppressed sparkline
    let suppressedSparkline: number[] = [];
    if (alertTimeline.status === "fulfilled") {
      type AlertBucket = { doc_count: number; suppressed?: { doc_count: number } };
      const agg = alertTimeline.value.aggregations as Record<string, { buckets: AlertBucket[] }> | undefined;
      const buckets = agg?.hourly?.buckets ?? [];
      suppressedSparkline = buckets.map((b) => b.suppressed?.doc_count ?? 0);
    }

    // MTTR sparkline: use incident creation counts as a proxy (correlates with resolution load)
    const mttrSparkline = incidentSparkline;

    // ── Assemble response ───────────────────────────────────────
    const aggs = resolvedResult.aggregations as Record<string, { value: number | null }> | undefined;
    // Prefer the direct field avg; fall back to scripted calc from timestamps
    const mttrSeconds = aggs?.avg_duration_field?.value ?? aggs?.avg_duration_script?.value ?? 0;
    const reflAggs = reflectionResult.aggregations as Record<string, { value: number | null }> | undefined;

    const metrics: DashboardMetrics = {
      active_incidents: activeResult.count,
      mttr_last_24h_seconds: Math.round(mttrSeconds),
      alerts_suppressed_today: suppressedCount,
      alerts_total_today: totalAlertsToday,
      reflection_loops_triggered: reflAggs?.total_reflections?.value ?? 0,
      sparklines: {
        active_incidents: incidentSparkline,
        mttr: mttrSparkline,
        suppressed: suppressedSparkline,
        reflections: reflectionSparkline,
      },
      trends: {
        active_incidents: deriveTrend(incidentSparkline),
        mttr: deriveTrend(mttrSparkline),
        suppressed: deriveTrend(suppressedSparkline),
        reflections: deriveTrend(reflectionSparkline),
      },
    };

    return NextResponse.json(metrics);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
