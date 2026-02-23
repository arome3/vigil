"use client";

import { useState } from "react";
import { ChevronRight, Check, X, Loader2 } from "lucide-react";
import { AGENT_CONFIG } from "@/lib/constants";
import { MonoText } from "@/components/shared/mono-text";
import { formatRelativeTime, formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { AgentActivityEntry, AgentName } from "@/types/agent";

interface TimelineEntryProps {
  entry: AgentActivityEntry;
}

export function TimelineEntry({ entry }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const agentConfig = AGENT_CONFIG[entry.agent_name as AgentName];
  const Icon = agentConfig?.icon;

  const statusIcon =
    entry.execution_status === "completed" ? <Check className="h-3 w-3 text-success" /> :
    entry.execution_status === "failed" ? <X className="h-3 w-3 text-error" /> :
    <Loader2 className="h-3 w-3 text-warning animate-spin" />;

  return (
    <div className="flex items-start gap-3 py-2 border-b border-border-subtle/50 last:border-0">
      {/* Timestamp */}
      <MonoText className="text-muted-foreground shrink-0 w-16 pt-0.5">
        {formatRelativeTime(entry.timestamp)}
      </MonoText>

      {/* Agent color accent */}
      <div
        className="w-0.5 self-stretch shrink-0 rounded-full"
        style={{ backgroundColor: agentConfig?.color }}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 shrink-0" style={{ color: agentConfig?.color }}>
            {Icon && <Icon className="h-3.5 w-3.5" />}
            <span className="text-xs font-medium">{agentConfig?.label}</span>
          </div>
          <span className="text-xs text-text-secondary truncate">{entry.action_detail}</span>
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            {entry.duration_ms && (
              <MonoText className="text-muted-foreground">{formatDuration(entry.duration_ms)}</MonoText>
            )}
            {statusIcon}
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 hover:bg-accent/50 rounded"
              aria-label={expanded ? "Collapse details" : "Expand details"}
            >
              <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />
            </button>
          </div>
        </div>

        {expanded && (
          <div className="mt-2 p-2 rounded bg-surface-sunken text-xs font-mono overflow-x-auto">
            <pre className="text-muted-foreground whitespace-pre-wrap">
              {JSON.stringify({ action_type: entry.action_type, status: entry.execution_status, duration_ms: entry.duration_ms }, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
