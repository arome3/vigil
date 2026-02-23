"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TriageDistributionProps {
  investigate: number;
  queue: number;
  suppress: number;
}

const COLORS = {
  investigate: "#EF4444",
  queue: "#F59E0B",
  suppress: "#22C55E",
};

export function TriageDistribution({ investigate, queue, suppress }: TriageDistributionProps) {
  const total = investigate + queue + suppress;
  const data = [
    { name: "Investigate", value: investigate, color: COLORS.investigate },
    { name: "Queue", value: queue, color: COLORS.queue },
    { name: "Suppress", value: suppress, color: COLORS.suppress },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Triage Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48 relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={70}
                paddingAngle={3}
                dataKey="value"
                isAnimationActive={false}
              >
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--vigil-surface-overlay)",
                  border: "1px solid var(--vigil-border-subtle)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-2xl font-bold tabular-nums">{total}</p>
              <p className="text-[10px] text-muted-foreground">alerts</p>
            </div>
          </div>
        </div>
        <div className="flex justify-center gap-4 mt-2 text-xs">
          {data.map((d) => (
            <div key={d.name} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
              <span className="text-muted-foreground">{d.name}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
