"use client";

import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Verification } from "@/types/incident";

interface VerificationPanelProps {
  verification: Verification;
}

export function VerificationPanel({ verification }: VerificationPanelProps) {
  const { health_score, passed, criteria_results, failure_analysis, iteration } = verification;
  const scoreColor =
    health_score >= 0.8 ? "bg-success" :
    health_score >= 0.5 ? "bg-warning" :
    "bg-error";
  const scoreTextColor =
    health_score >= 0.8 ? "text-success" :
    health_score >= 0.5 ? "text-warning" :
    "text-error";

  return (
    <div className="space-y-4">
      {/* Health score bar */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium">Health Score</span>
          <span className={cn("text-sm font-bold tabular-nums", scoreTextColor)}>
            {(health_score * 100).toFixed(0)}%
          </span>
        </div>
        <div className="relative h-3 rounded-full bg-surface-sunken overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", scoreColor)}
            style={{ width: `${health_score * 100}%` }}
          />
          {/* Threshold line at 80% */}
          <div
            className="absolute top-0 bottom-0 w-px bg-muted-foreground/50"
            style={{ left: "80%" }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-muted-foreground">0%</span>
          <span className="text-[10px] text-muted-foreground">Threshold: 80%</span>
          <span className="text-[10px] text-muted-foreground">100%</span>
        </div>
      </div>

      {/* Overall status */}
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium",
        passed ? "bg-success/10 text-success" : "bg-error/10 text-error"
      )}>
        {passed ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
        {passed ? `Verification passed (iteration ${iteration})` : `Verification failed (iteration ${iteration})`}
      </div>

      {/* Per-criteria results */}
      <div className="space-y-1">
        <h4 className="text-xs font-medium mb-2">Success Criteria</h4>
        {criteria_results.map((cr, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 text-xs border-b border-border-subtle/50 last:border-0">
            {cr.passed ? (
              <Check className="h-3 w-3 text-success shrink-0" />
            ) : (
              <X className="h-3 w-3 text-error shrink-0" />
            )}
            <span className="flex-1">{cr.service_name}: {cr.metric}</span>
            <span className="font-mono text-muted-foreground">
              {cr.current_value.toFixed(2)} {cr.operator} {cr.threshold}
            </span>
          </div>
        ))}
      </div>

      {/* Failure analysis */}
      {failure_analysis && (
        <div className="p-3 rounded-lg bg-error/5 border border-error/20">
          <h4 className="text-xs font-medium text-error mb-1">Failure Analysis</h4>
          <p className="text-xs text-text-secondary">{failure_analysis}</p>
        </div>
      )}
    </div>
  );
}
