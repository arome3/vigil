import type { DashboardMetrics } from "@/types/metrics";

export const mockDashboardMetrics: DashboardMetrics = {
  active_incidents: 2,
  mttr_last_24h_seconds: 252,
  alerts_suppressed_today: 14,
  alerts_total_today: 38,
  reflection_loops_triggered: 1,
  sparklines: {
    active_incidents: [
      0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 0, 0, 1, 1, 2, 2, 2,
      2,
    ],
    mttr: [
      0, 0, 0, 0, 0, 0, 310, 280, 295, 252, 252, 260, 240, 255, 248, 270,
      230, 0, 0, 265, 252, 252, 252, 252,
    ],
    suppressed: [
      0, 0, 0, 1, 0, 0, 1, 2, 1, 1, 2, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0,
      1,
    ],
    reflections: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0,
    ],
  },
  trends: {
    active_incidents: "stable",
    mttr: "down",
    suppressed: "up",
    reflections: "stable",
  },
};

export interface TimelineDataPoint {
  time: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Stacked area chart data — hourly incident counts for the last 24 hours */
export const mockIncidentTimelineData: TimelineDataPoint[] = [
  { time: "2026-02-16T12:00Z", critical: 0, high: 0, medium: 1, low: 2 },
  { time: "2026-02-16T13:00Z", critical: 0, high: 0, medium: 1, low: 1 },
  { time: "2026-02-16T14:00Z", critical: 0, high: 0, medium: 0, low: 1 },
  { time: "2026-02-16T15:00Z", critical: 0, high: 1, medium: 0, low: 1 },
  { time: "2026-02-16T16:00Z", critical: 0, high: 1, medium: 1, low: 0 },
  { time: "2026-02-16T17:00Z", critical: 0, high: 0, medium: 1, low: 1 },
  { time: "2026-02-16T18:00Z", critical: 1, high: 0, medium: 0, low: 1 },
  { time: "2026-02-16T19:00Z", critical: 1, high: 1, medium: 0, low: 0 },
  { time: "2026-02-16T20:00Z", critical: 1, high: 1, medium: 1, low: 1 },
  { time: "2026-02-16T21:00Z", critical: 0, high: 1, medium: 1, low: 2 },
  { time: "2026-02-16T22:00Z", critical: 0, high: 0, medium: 1, low: 1 },
  { time: "2026-02-16T23:00Z", critical: 0, high: 0, medium: 0, low: 1 },
  { time: "2026-02-17T00:00Z", critical: 0, high: 0, medium: 0, low: 0 },
  { time: "2026-02-17T01:00Z", critical: 0, high: 0, medium: 0, low: 0 },
  { time: "2026-02-17T02:00Z", critical: 0, high: 0, medium: 1, low: 0 },
  { time: "2026-02-17T03:00Z", critical: 0, high: 0, medium: 0, low: 1 },
  { time: "2026-02-17T04:00Z", critical: 0, high: 0, medium: 0, low: 0 },
  { time: "2026-02-17T05:00Z", critical: 0, high: 0, medium: 0, low: 0 },
  { time: "2026-02-17T06:00Z", critical: 0, high: 0, medium: 0, low: 1 },
  { time: "2026-02-17T07:00Z", critical: 0, high: 0, medium: 1, low: 1 },
  { time: "2026-02-17T08:00Z", critical: 0, high: 1, medium: 0, low: 0 },
  { time: "2026-02-17T09:00Z", critical: 0, high: 1, medium: 1, low: 1 },
  { time: "2026-02-17T10:00Z", critical: 1, high: 0, medium: 0, low: 1 },
  { time: "2026-02-17T11:00Z", critical: 1, high: 1, medium: 0, low: 0 },
];
