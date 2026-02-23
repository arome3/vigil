import type { ServiceHealth } from "@/types/metrics";

export const mockServiceHealth: ServiceHealth[] = [
  {
    service_name: "api-gateway",
    metrics: {
      latency: {
        current: 45,
        baseline_mean: 42,
        baseline_stddev: 5,
        deviation_sigma: 0.6,
      },
      error_rate: {
        current: 0.12,
        baseline_mean: 0.1,
        baseline_stddev: 0.05,
        deviation_sigma: 0.4,
      },
      throughput: {
        current: 1200,
        baseline_mean: 1150,
        baseline_stddev: 100,
        deviation_sigma: 0.5,
      },
    },
  },
  {
    service_name: "payment-service",
    metrics: {
      latency: {
        current: 32,
        baseline_mean: 30,
        baseline_stddev: 3,
        deviation_sigma: 0.67,
      },
      error_rate: {
        current: 0.08,
        baseline_mean: 0.05,
        baseline_stddev: 0.02,
        deviation_sigma: 1.5,
      },
      throughput: {
        current: 800,
        baseline_mean: 820,
        baseline_stddev: 80,
        deviation_sigma: 0.25,
      },
    },
  },
  {
    service_name: "user-service",
    metrics: {
      latency: {
        current: 28,
        baseline_mean: 25,
        baseline_stddev: 4,
        deviation_sigma: 0.75,
      },
      error_rate: {
        current: 0.03,
        baseline_mean: 0.02,
        baseline_stddev: 0.01,
        deviation_sigma: 1.0,
      },
      throughput: {
        current: 950,
        baseline_mean: 900,
        baseline_stddev: 90,
        deviation_sigma: 0.56,
      },
    },
  },
  {
    service_name: "notification-svc",
    metrics: {
      latency: {
        current: 55,
        baseline_mean: 50,
        baseline_stddev: 8,
        deviation_sigma: 0.63,
      },
      error_rate: {
        current: 0.15,
        baseline_mean: 0.1,
        baseline_stddev: 0.04,
        deviation_sigma: 1.25,
      },
      throughput: {
        current: 600,
        baseline_mean: 580,
        baseline_stddev: 60,
        deviation_sigma: 0.33,
      },
    },
  },
];
