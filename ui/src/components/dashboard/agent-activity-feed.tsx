"use client";

import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AGENT_CONFIG } from "@/lib/constants";
import { formatRelativeTime } from "@/lib/formatters";
import { MonoText } from "@/components/shared/mono-text";
import type { AgentActivityEntry } from "@/types/agent";
import type { AgentName } from "@/types/agent";

interface AgentActivityFeedProps {
  entries: AgentActivityEntry[];
}

export function AgentActivityFeed({ entries }: AgentActivityFeedProps) {
  const [isPaused, setIsPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPaused && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [entries, isPaused]);

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Agent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground text-center py-8">
            No agent activity yet — run a demo scenario to see agents in action.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Agent Activity</CardTitle>
        {isPaused && (
          <span className="text-[10px] text-muted-foreground">Paused</span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea
          className="h-52"
          ref={scrollRef}
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          <div className="px-4 pb-4 space-y-1" role="log" aria-live="polite" aria-label="Agent activity feed">
            {entries.map((entry) => {
              const agentConfig = AGENT_CONFIG[entry.agent_name as AgentName];
              const Icon = agentConfig?.icon;
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 py-1.5 text-xs border-b border-border-subtle/50 last:border-0"
                >
                  <MonoText className="text-muted-foreground shrink-0 w-12">
                    {formatRelativeTime(entry.timestamp)}
                  </MonoText>
                  <div className="flex items-center gap-1 shrink-0" style={{ color: agentConfig?.color }}>
                    {Icon && <Icon className="h-3 w-3" />}
                  </div>
                  <span className="text-text-secondary truncate flex-1">{entry.action_detail}</span>
                  {entry.incident_id && (
                    <MonoText className="text-muted-foreground shrink-0">{entry.incident_id}</MonoText>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
