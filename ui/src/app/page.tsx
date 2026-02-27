"use client";

import { useEffect, useState } from "react";
import { MetricTile } from "@/components/dashboard/metric-tile";
import { IncidentTimelineChart } from "@/components/dashboard/incident-timeline-chart";
import { AgentActivityFeed } from "@/components/dashboard/agent-activity-feed";
import { HealthHeatmap } from "@/components/dashboard/health-heatmap";
import { ChangeCorrelationTable, type ChangeCorrelationRow } from "@/components/dashboard/change-correlation-table";
import { TriageDistribution } from "@/components/dashboard/triage-distribution";
import { TopAffectedAssets } from "@/components/dashboard/top-affected-assets";
import { Skeleton } from "@/components/ui/skeleton";
import { useMetricsStore } from "@/stores/metrics-store";
import { useAgentStore } from "@/stores/agent-store";
import { useIncidentStore } from "@/stores/incident-store";
import { formatDurationSeconds } from "@/lib/formatters";

export default function DashboardPage() {
  const dashboard = useMetricsStore((s) => s.dashboard);
  const serviceHealth = useMetricsStore((s) => s.serviceHealth);
  const activityFeed = useAgentStore((s) => s.activityFeed);
  const setDashboard = useMetricsStore((s) => s.setDashboard);
  const setServiceHealth = useMetricsStore((s) => s.setServiceHealth);
  const setActivityFeed = useAgentStore((s) => s.setActivityFeed);
  const setIncidents = useIncidentStore((s) => s.setIncidents);
  const incidentMap = useIncidentStore((s) => s.incidents);
  const incidents = Array.from(incidentMap.values());

  const [timelineData, setTimelineData] = useState<Array<{ time: string; critical: number; high: number; medium: number; low: number }>>([]);
  const [correlations, setCorrelations] = useState<ChangeCorrelationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

    async function loadLive() {
      try {
        const { getDashboardMetrics, getServiceHealth, getActivityFeed, getIncidents } = await import("@/lib/api");
        const [metrics, health, activity, inc] = await Promise.all([
          getDashboardMetrics(),
          getServiceHealth(),
          getActivityFeed(),
          getIncidents(),
        ]);
        setDashboard(metrics);
        setServiceHealth(health);
        setActivityFeed(activity);
        setIncidents(inc);
        // Derive timeline from incidents — pad full 24h window with empty buckets
        const buckets = new Map<string, { critical: number; high: number; medium: number; low: number }>();
        const nowMs = Date.now();
        for (let h = 23; h >= 0; h--) {
          const d = new Date(nowMs - h * 3600_000);
          const key = d.toISOString().slice(0, 13) + ":00:00Z";
          buckets.set(key, { critical: 0, high: 0, medium: 0, low: 0 });
        }
        inc.forEach((i) => {
          const hour = i.created_at?.slice(0, 13) + ":00:00Z";
          const b = buckets.get(hour) ?? { critical: 0, high: 0, medium: 0, low: 0 };
          if (i.severity in b) b[i.severity as keyof typeof b]++;
          buckets.set(hour, b);
        });
        setTimelineData(
          Array.from(buckets.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([time, counts]) => ({ time: time.slice(11, 16), ...counts }))
        );
        // Change correlations from investigations
        setCorrelations(inc.filter((i) => i.investigation?.change_correlation?.matched).map((i) => {
          const cc = i.investigation!.change_correlation!;
          return { incident_id: i.id, commit_sha: cc.commit_sha, author: cc.author, pr_number: cc.pr_number, time_gap_seconds: cc.time_gap_seconds, confidence: cc.confidence };
        }));
      } catch (e) {
        console.error("Failed to load live dashboard data:", e);
      } finally {
        setLoading(false);
      }
    }

    async function loadMock() {
      try {
        const [metricsModule, healthModule, timelineModule, incidentsModule, correlationModule] = await Promise.all([
          import("@/data/mock/metrics"),
          import("@/data/mock/health"),
          import("@/data/mock/timeline"),
          import("@/data/mock/incidents"),
          import("@/data/mock/change-correlation"),
        ]);
        setDashboard(metricsModule.mockDashboardMetrics);
        setServiceHealth(healthModule.mockServiceHealth);
        setActivityFeed(timelineModule.mockActivityFeed);
        setIncidents(incidentsModule.mockIncidents);
        setTimelineData(metricsModule.mockIncidentTimelineData);
        setCorrelations(correlationModule.mockChangeCorrelations);
      } catch (e) {
        console.error("Failed to load mock data:", e);
      } finally {
        setLoading(false);
      }
    }

    if (isDemo) {
      loadMock();
    } else {
      loadLive();
    }
  }, [setDashboard, setServiceHealth, setActivityFeed, setIncidents]);

  if (loading || !dashboard) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  const investigate = incidents.filter((i) => ["investigating", "threat_hunting", "planning", "awaiting_approval", "executing", "verifying", "reflecting"].includes(i.status)).length;
  const suppress = incidents.filter((i) => i.status === "suppressed").length;

  const assetCounts = new Map<string, { count: number; criticality: "tier-1" | "tier-2" | "tier-3" }>();
  incidents.forEach((inc) => {
    inc.affected_assets.forEach((a) => {
      const existing = assetCounts.get(a.asset_name);
      assetCounts.set(a.asset_name, { count: (existing?.count || 0) + 1, criticality: a.criticality });
    });
  });
  const topAssets = Array.from(assetCounts.entries())
    .map(([name, data]) => ({ name, count: data.count, criticality: data.criticality }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricTile label="Active Incidents" value={dashboard.active_incidents} formattedValue={String(dashboard.active_incidents)} trend={dashboard.trends.active_incidents} sparklineData={dashboard.sparklines.active_incidents} thresholdColor={dashboard.active_incidents >= 3 ? "#EF4444" : dashboard.active_incidents >= 1 ? "#F59E0B" : undefined} />
        <MetricTile label="MTTR (24h)" value={dashboard.mttr_last_24h_seconds} formattedValue={formatDurationSeconds(dashboard.mttr_last_24h_seconds)} trend={dashboard.trends.mttr} sparklineData={dashboard.sparklines.mttr} thresholdColor={dashboard.mttr_last_24h_seconds >= 900 ? "#EF4444" : undefined} />
        <MetricTile label="Alerts Suppressed" value={dashboard.alerts_suppressed_today} formattedValue={`${dashboard.alerts_suppressed_today} / ${dashboard.alerts_total_today}`} trend={dashboard.trends.suppressed} sparklineData={dashboard.sparklines.suppressed} />
        <MetricTile label="Reflection Loops" value={dashboard.reflection_loops_triggered} formattedValue={String(dashboard.reflection_loops_triggered)} trend={dashboard.trends.reflections} sparklineData={dashboard.sparklines.reflections} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <IncidentTimelineChart data={timelineData} />
        <AgentActivityFeed entries={activityFeed} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <HealthHeatmap services={serviceHealth} />
        <ChangeCorrelationTable rows={correlations} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <TriageDistribution investigate={investigate || 12} queue={12} suppress={dashboard.alerts_suppressed_today} />
        <TopAffectedAssets assets={topAssets.length > 0 ? topAssets : [
          { name: "srv-payment-01", count: 4, criticality: "tier-1" },
          { name: "api-gateway", count: 3, criticality: "tier-1" },
          { name: "db-customers", count: 2, criticality: "tier-1" },
          { name: "user-service", count: 2, criticality: "tier-2" },
          { name: "notification-svc", count: 1, criticality: "tier-3" },
        ]} />
      </div>
    </div>
  );
}
