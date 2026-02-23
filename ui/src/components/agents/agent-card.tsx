"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AGENT_CONFIG } from "@/lib/constants";
import { formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { Agent } from "@/types/agent";
import type { AgentName } from "@/types/agent";

interface AgentCardProps {
  agent: Agent;
}

const STATUS_STYLES = {
  active:    "bg-info/15 text-info",
  waiting:   "bg-warning/15 text-warning",
  completed: "bg-success/15 text-success",
  error:     "bg-error/15 text-error",
  idle:      "bg-muted text-muted-foreground",
};

export function AgentCard({ agent }: AgentCardProps) {
  const config = AGENT_CONFIG[agent.name as AgentName];
  const Icon = config?.icon;

  return (
    <Card className="hover:border-border-strong transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div
            className="flex items-center justify-center h-10 w-10 rounded-lg shrink-0"
            style={{ backgroundColor: `${config?.color}20`, color: config?.color }}
          >
            {Icon && <Icon className="h-5 w-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium truncate">{config?.label || agent.name}</h3>
              <Badge className={cn("text-[10px] h-4 px-1.5", STATUS_STYLES[agent.status])}>
                {agent.status}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{agent.description}</p>
            <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
              <span className="tabular-nums">{agent.tool_calls_today} calls today</span>
              <span className="tabular-nums">avg {formatDuration(agent.avg_execution_time_ms)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
