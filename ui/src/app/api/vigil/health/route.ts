import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { ServiceHealth } from "@/types/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await client.search({
      index: "vigil-metrics-default",
      size: 0,
      query: { range: { "@timestamp": { gte: "now-3h" } } },
      aggs: {
        by_service: {
          terms: { field: "service.name.keyword", size: 20 },
          aggs: {
            avg_latency: { avg: { field: "transaction.duration.us" } },
            error_rate: {
              filter: { term: { "event.outcome.keyword": "failure" } },
            },
            total: { value_count: { field: "event.outcome.keyword" } },
            throughput: { value_count: { field: "@timestamp" } },
          },
        },
      },
    });

    const aggs = result.aggregations as Record<string, { buckets: Record<string, unknown>[] }>;
    const buckets = aggs?.by_service?.buckets ?? [];

    const services: ServiceHealth[] = buckets.map((bucket) => {
      const total = (bucket.total as { value: number })?.value || 1;
      const errors = (bucket.error_rate as { doc_count: number })?.doc_count ?? 0;
      const avgLatency = (bucket.avg_latency as { value: number | null })?.value ?? 0;
      const throughput = (bucket.throughput as { value: number })?.value ?? 0;

      return {
        service_name: bucket.key as string,
        metrics: {
          latency: {
            current: Math.round(avgLatency / 1000) / 1000, // us → ms, 3 decimal
            baseline_mean: 0.5,
            baseline_stddev: 0.1,
            deviation_sigma: 0,
          },
          error_rate: {
            current: Math.round((errors / total) * 1000) / 1000,
            baseline_mean: 0.01,
            baseline_stddev: 0.005,
            deviation_sigma: 0,
          },
          throughput: {
            current: Math.round(throughput / 180), // per minute (3h window)
            baseline_mean: 100,
            baseline_stddev: 20,
            deviation_sigma: 0,
          },
        },
      };
    });

    return NextResponse.json(services);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
