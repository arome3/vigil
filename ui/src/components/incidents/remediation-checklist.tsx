"use client";

import { Check, X, Clock, Loader2, Shield, Wrench, MessageSquare, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RemediationAction } from "@/types/incident";

interface RemediationChecklistProps {
  actions: RemediationAction[];
}

const ACTION_TYPE_CONFIG = {
  containment:    { icon: Shield,        label: "Containment",    color: "bg-error/10 text-error" },
  remediation:    { icon: Wrench,        label: "Remediation",    color: "bg-warning/10 text-warning" },
  communication:  { icon: MessageSquare, label: "Communication",  color: "bg-info/10 text-info" },
  documentation:  { icon: FileText,      label: "Documentation",  color: "bg-muted text-muted-foreground" },
};

const STATUS_ICONS = {
  pending:   Clock,
  executing: Loader2,
  completed: Check,
  failed:    X,
};

export function RemediationChecklist({ actions }: RemediationChecklistProps) {
  const sorted = [...actions].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-2">
      {sorted.map((action) => {
        const typeConfig = ACTION_TYPE_CONFIG[action.action_type];
        const StatusIcon = STATUS_ICONS[action.status];
        const statusColor =
          action.status === "completed" ? "text-success" :
          action.status === "failed" ? "text-error" :
          action.status === "executing" ? "text-warning" :
          "text-muted-foreground";

        return (
          <div
            key={action.order}
            className={cn(
              "flex items-start gap-3 p-3 rounded-lg border border-border-subtle",
              action.status === "completed" && "opacity-70"
            )}
          >
            {/* Step number */}
            <span className="flex items-center justify-center h-6 w-6 rounded-full bg-accent text-xs font-bold shrink-0">
              {action.order}
            </span>

            {/* Status icon */}
            <StatusIcon
              className={cn("h-4 w-4 mt-0.5 shrink-0", statusColor, action.status === "executing" && "animate-spin")}
            />

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium", typeConfig.color)}>
                  {typeConfig.label}
                </span>
                {action.approval_required && (
                  <Badge variant="outline" className="text-[10px] h-4 px-1">
                    Approval Required
                  </Badge>
                )}
              </div>
              <p className="text-xs mt-1">{action.description}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">{action.target_system}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
