"use client";

import { cn } from "@/lib/utils";

interface ConfidenceBadgeProps {
  level: "high" | "medium" | "low";
  value?: number;
}

const LEVEL_STYLES = {
  high:   { bg: "rgba(34, 197, 94, 0.15)", color: "#22C55E", label: "High" },
  medium: { bg: "rgba(245, 158, 11, 0.15)", color: "#F59E0B", label: "Medium" },
  low:    { bg: "rgba(100, 116, 139, 0.15)", color: "#94A3B8", label: "Low" },
};

export function ConfidenceBadge({ level, value }: ConfidenceBadgeProps) {
  const style = LEVEL_STYLES[level];
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium")}
      style={{ color: style.color, backgroundColor: style.bg }}
    >
      {style.label}
      {value !== undefined && <span className="font-mono">{(value * 100).toFixed(0)}%</span>}
    </span>
  );
}
