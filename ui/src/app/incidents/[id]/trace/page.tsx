"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AgentTraceNode } from "@/components/agents/agent-trace-node";
import { MonoText } from "@/components/shared/mono-text";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/formatters";
import type { TraceNode } from "@/types/agent";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function TracePage() {
  const params = useParams();
  const id = params.id as string;
  const [trace, setTrace] = useState<TraceNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { mockTraceTree } = await import("@/data/mock/trace");
        setTrace(mockTraceTree);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading || !trace) {
    return (
      <div className="p-6">
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/incidents/${id}`} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">Agent Trace</h1>
        <MonoText className="text-muted-foreground">{id}</MonoText>
        <span className="text-xs text-muted-foreground ml-auto">
          Total: <MonoText>{formatDuration(trace.duration_ms)}</MonoText>
        </span>
      </div>

      <Card>
        <CardContent className="p-2">
          <AgentTraceNode node={trace} totalDuration={trace.duration_ms} />
        </CardContent>
      </Card>
    </div>
  );
}
