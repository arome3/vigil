export interface ServiceHealth {
  service_name: string;
  metrics: {
    latency: MetricPoint;
    error_rate: MetricPoint;
    throughput: MetricPoint;
  };
}

export interface MetricPoint {
  current: number;
  baseline_mean: number;
  baseline_stddev: number;
  deviation_sigma: number;
}

export interface Baseline {
  service_name: string;
  metric: string;
  mean_7d: number;
  stddev_7d: number;
  p95_7d: number;
  updated_at: string;
}

export interface DashboardMetrics {
  active_incidents: number;
  mttr_last_24h_seconds: number;
  alerts_suppressed_today: number;
  alerts_total_today: number;
  reflection_loops_triggered: number;
  sparklines: {
    active_incidents: number[];
    mttr: number[];
    suppressed: number[];
    reflections: number[];
  };
  trends: {
    active_incidents: "up" | "down" | "stable";
    mttr: "up" | "down" | "stable";
    suppressed: "up" | "down" | "stable";
    reflections: "up" | "down" | "stable";
  };
}
