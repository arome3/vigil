import { create } from "zustand";
import type { DashboardMetrics, ServiceHealth } from "@/types/metrics";
import type { WebSocketEvent, MetricsSnapshot } from "@/types/websocket";

interface MetricsState {
  dashboard: DashboardMetrics | null;
  serviceHealth: ServiceHealth[];

  setDashboard: (metrics: DashboardMetrics) => void;
  setServiceHealth: (health: ServiceHealth[]) => void;
  handleEvent: (event: WebSocketEvent) => void;
}

export const useMetricsStore = create<MetricsState>((set) => ({
  dashboard: null,
  serviceHealth: [],

  setDashboard: (metrics) => set({ dashboard: metrics }),
  setServiceHealth: (health) => set({ serviceHealth: health }),

  handleEvent: (event) => {
    if (event.type === "metrics.updated") {
      const snap = event.data as MetricsSnapshot;
      set((s) => ({
        dashboard: s.dashboard
          ? {
              ...s.dashboard,
              active_incidents: snap.active_incidents,
              mttr_last_24h_seconds: snap.mttr_last_24h_seconds,
              alerts_suppressed_today: snap.alerts_suppressed_today,
              reflection_loops_triggered: snap.reflection_loops_triggered,
              sparklines: snap.sparklines,
            }
          : null,
      }));
    }
  },
}));
