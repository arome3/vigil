"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ServiceHealth } from "@/types/metrics";

interface HealthHeatmapProps {
  services: ServiceHealth[];
}

const METRICS = ["latency", "error_rate", "throughput"] as const;
const METRIC_LABELS: Record<string, string> = {
  latency: "Latency",
  error_rate: "Error Rate",
  throughput: "Throughput",
};

function deviationColor(sigma: number): string {
  if (Math.abs(sigma) <= 1) return "bg-success/20 text-success";
  if (Math.abs(sigma) <= 2) return "bg-warning/20 text-warning";
  return "bg-error/20 text-error";
}

export function HealthHeatmap({ services }: HealthHeatmapProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Service Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" role="table">
            <thead>
              <tr>
                <th className="text-left font-medium text-muted-foreground pb-2 pr-3">Service</th>
                {METRICS.map((m) => (
                  <th key={m} className="text-center font-medium text-muted-foreground pb-2 px-2">
                    {METRIC_LABELS[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => (
                <tr key={svc.service_name}>
                  <td className="py-1 pr-3 font-mono text-xs">{svc.service_name}</td>
                  {METRICS.map((metric) => {
                    const point = svc.metrics[metric];
                    return (
                      <td key={metric} className="px-1 py-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className={cn(
                                "flex items-center justify-center h-8 rounded text-xs font-mono cursor-default",
                                deviationColor(point.deviation_sigma)
                              )}
                            >
                              {point.deviation_sigma.toFixed(1)}σ
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="text-xs space-y-1">
                              <p>Current: {point.current.toFixed(2)}</p>
                              <p>Baseline: {point.baseline_mean.toFixed(2)} ±{point.baseline_stddev.toFixed(2)}</p>
                              <p>Deviation: {point.deviation_sigma.toFixed(2)}σ</p>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
