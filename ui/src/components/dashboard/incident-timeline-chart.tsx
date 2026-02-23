"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TimelineDataPoint {
  time: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface IncidentTimelineChartProps {
  data: TimelineDataPoint[];
}

export function IncidentTimelineChart({ data }: IncidentTimelineChartProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Incident Timeline (24h)</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--vigil-text-disabled)" }}
                axisLine={{ stroke: "var(--vigil-border-subtle)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--vigil-text-disabled)" }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--vigil-surface-overlay)",
                  border: "1px solid var(--vigil-border-subtle)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--vigil-text-primary)" }}
              />
              <Area type="monotone" dataKey="critical" stackId="1" stroke="#EF4444" fill="#EF4444" fillOpacity={0.4} />
              <Area type="monotone" dataKey="high" stackId="1" stroke="#F97316" fill="#F97316" fillOpacity={0.3} />
              <Area type="monotone" dataKey="medium" stackId="1" stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.25} />
              <Area type="monotone" dataKey="low" stackId="1" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
