"use client";

import { cn } from "@/lib/utils";
import { SEVERITY_CONFIG } from "@/lib/constants";
import type { Severity } from "@/types/incident";

interface SeverityBadgeProps {
  severity: Severity;
  size?: "sm" | "md";
}

export function SeverityBadge({ severity, size = "md" }: SeverityBadgeProps) {
  const config = SEVERITY_CONFIG[severity];
  const Icon = config.icon;

  return (
    <span
      aria-label={`Severity: ${severity}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium capitalize whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      )}
      style={{
        color: config.color,
        backgroundColor: config.bgColor,
      }}
    >
      <Icon className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
      {severity}
    </span>
  );
}
