"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AssetData {
  name: string;
  count: number;
  criticality: "tier-1" | "tier-2" | "tier-3";
}

interface TopAffectedAssetsProps {
  assets: AssetData[];
}

const TIER_COLORS = {
  "tier-1": "#EF4444",
  "tier-2": "#F97316",
  "tier-3": "#3B82F6",
};

export function TopAffectedAssets({ assets }: TopAffectedAssetsProps) {
  const sorted = [...assets].sort((a, b) => b.count - a.count).slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Top Affected Assets</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sorted} layout="vertical" margin={{ left: 0, right: 16 }}>
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: "var(--vigil-text-disabled)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                dataKey="name"
                type="category"
                tick={{ fontSize: 10, fill: "var(--vigil-text-secondary)" }}
                axisLine={false}
                tickLine={false}
                width={100}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--vigil-surface-overlay)",
                  border: "1px solid var(--vigil-border-subtle)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {sorted.map((entry) => (
                  <Cell key={entry.name} fill={TIER_COLORS[entry.criticality]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
