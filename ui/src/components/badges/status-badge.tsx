"use client";

import { cn } from "@/lib/utils";
import { STATE_CONFIG } from "@/lib/constants";
import type { IncidentStatus } from "@/types/incident";

interface StatusBadgeProps {
  status: IncidentStatus;
  size?: "sm" | "md";
  animated?: boolean;
}

export function StatusBadge({ status, size = "md", animated = false }: StatusBadgeProps) {
  const config = STATE_CONFIG[status];
  const Icon = config.icon;

  return (
    <span
      role="status"
      aria-label={`Incident status: ${config.label}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        animated && "animate-pulse-ring"
      )}
      style={{
        color: config.color,
        backgroundColor: config.bgColor,
      }}
    >
      <Icon className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
      {config.label}
    </span>
  );
}
