"use client";

import { useState } from "react";
import { Check, X, Loader2, ChevronRight, Clock } from "lucide-react";
import { AGENT_CONFIG } from "@/lib/constants";
import { MonoText } from "@/components/shared/mono-text";
import { formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { TraceNode, AgentName } from "@/types/agent";

interface AgentTraceNodeProps {
  node: TraceNode;
  totalDuration: number;
  depth?: number;
}

export function AgentTraceNode({ node, totalDuration, depth = 0 }: AgentTraceNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const agentConfig = node.agent_name ? AGENT_CONFIG[node.agent_name as AgentName] : null;
  const Icon = agentConfig?.icon;
  const barWidth = totalDuration > 0 ? Math.max(2, (node.duration_ms / totalDuration) * 100) : 0;
  const barColor = agentConfig?.color || "var(--color-muted-foreground)";

  const statusIcon =
    node.status === "completed" ? <Check className="h-3 w-3 text-success" /> :
    node.status === "failed" ? <X className="h-3 w-3 text-error" /> :
    <Loader2 className="h-3 w-3 text-warning animate-spin" />;

  const isWait = node.type === "wait";

  return (
    <div className="select-none">
      <div
        className={cn(
          "flex items-center gap-2 py-1 px-2 rounded hover:bg-accent/30 cursor-pointer text-xs",
          depth === 0 && "font-medium"
        )}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Expand/collapse */}
        {node.children.length > 0 ? (
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform text-muted-foreground", expanded && "rotate-90")} />
        ) : (
          <span className="w-3" />
        )}

        {/* Agent/tool icon */}
        {isWait ? (
          <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : Icon ? (
          <Icon className="h-3 w-3 shrink-0" style={{ color: barColor }} />
        ) : (
          <span className="h-3 w-3 rounded-sm shrink-0" style={{ backgroundColor: barColor }} />
        )}

        {/* Name */}
        <span className={cn("shrink-0", node.type === "tool" && "font-mono")}>{node.name}</span>

        {/* Timing bar */}
        <div className="flex-1 mx-2 h-3 relative">
          <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${barWidth}%`, backgroundColor: barColor, opacity: 0.4 }} />
        </div>

        {/* Duration */}
        <MonoText className="text-muted-foreground shrink-0">{formatDuration(node.duration_ms)}</MonoText>

        {/* Status */}
        {statusIcon}
      </div>

      {/* Children */}
      {expanded && node.children.map((child) => (
        <AgentTraceNode key={child.id} node={child} totalDuration={totalDuration} depth={depth + 1} />
      ))}

      {/* Expanded details */}
      {expanded && node.children.length === 0 && (node.input || node.output) && (
        <div className="ml-12 mr-4 mb-2 p-2 rounded bg-surface-sunken text-xs font-mono overflow-x-auto" style={{ marginLeft: `${depth * 20 + 40}px` }}>
          {node.input && (
            <details>
              <summary className="text-muted-foreground cursor-pointer mb-1">Input</summary>
              <pre className="text-muted-foreground whitespace-pre-wrap">{JSON.stringify(node.input, null, 2)}</pre>
            </details>
          )}
          {node.output && (
            <details>
              <summary className="text-muted-foreground cursor-pointer mb-1">Output</summary>
              <pre className="text-muted-foreground whitespace-pre-wrap">{JSON.stringify(node.output, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
