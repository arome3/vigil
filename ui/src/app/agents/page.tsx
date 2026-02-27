"use client";

import { useEffect, useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Agent } from "@/types/agent";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
          const { mockAgents } = await import("@/data/mock/agents");
          setAgents(mockAgents);
        } else {
          const { getAgents } = await import("@/lib/api");
          const a = await getAgents();
          setAgents(a);
        }
      } catch (e) {
        console.error("Failed to load agents:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <h1 className="text-lg font-semibold">Agents</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <AgentCard key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}
