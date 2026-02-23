"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MetricTileProps {
  label: string;
  value: number;
  formattedValue: string;
  trend: "up" | "down" | "stable";
  sparklineData: number[];
  thresholdColor?: string;
}

export function MetricTile({
  label,
  value,
  formattedValue,
  trend,
  sparklineData,
  thresholdColor,
}: MetricTileProps) {
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = trend === "up" ? "text-error" : trend === "down" ? "text-success" : "text-muted-foreground";
  const chartData = sparklineData.map((v, i) => ({ i, v }));

  return (
    <Card className={cn("relative overflow-hidden", thresholdColor && "ring-1")} style={thresholdColor ? { boxShadow: `0 0 12px ${thresholdColor}26` } : undefined}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p
              className="text-2xl font-bold tabular-nums"
              role="meter"
              aria-valuenow={value}
              aria-label={`${label}: ${formattedValue}`}
            >
              {formattedValue}
            </p>
          </div>
          <TrendIcon className={cn("h-4 w-4 mt-1", trendColor)} />
        </div>
        <div className="h-8 mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id={`sparkGrad-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-info)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--color-info)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--color-info)"
                strokeWidth={1.5}
                fill={`url(#sparkGrad-${label})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
