"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MonoText } from "@/components/shared/mono-text";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/formatters";
import { AGENT_CONFIG } from "@/lib/constants";
import { Check, X, ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { Retrospective } from "@/types/learning";
import type { AgentName } from "@/types/agent";

export default function RetrospectivePage() {
  const [retro, setRetro] = useState<Retrospective | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { mockRetrospective } = await import("@/data/mock/learning");
        setRetro(mockRetrospective);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading || !retro) {
    return <div className="p-6"><Skeleton className="h-96" /></div>;
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/learning" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">Retrospective</h1>
        <MonoText className="text-muted-foreground">{retro.incident_id}</MonoText>
      </div>

      <p className="text-sm text-muted-foreground">{retro.timeline_summary}</p>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Agent Performance */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Agent Performance</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {retro.agent_performance.map((ap) => {
                const config = AGENT_CONFIG[ap.agent_name as AgentName];
                const Icon = config?.icon;
                return (
                  <div key={ap.agent_name} className="flex items-center gap-2 text-xs py-1.5 border-b border-border-subtle/50 last:border-0">
                    {Icon && <Icon className="h-3 w-3" style={{ color: config?.color }} />}
                    <span className="flex-1">{config?.label || ap.agent_name}</span>
                    <span className="text-muted-foreground tabular-nums">{ap.tools_called} tools</span>
                    <MonoText className="text-muted-foreground">{formatDuration(ap.reasoning_time_ms)}</MonoText>
                    {ap.status === "completed" ? <Check className="h-3 w-3 text-success" /> : <X className="h-3 w-3 text-error" />}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Analysis */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-success">What Went Well</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs">
                {retro.what_went_well.map((item, i) => (
                  <li key={i} className="flex items-start gap-2"><Check className="h-3 w-3 text-success mt-0.5 shrink-0" />{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-warning">Needs Improvement</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs">
                {retro.needs_improvement.map((item, i) => (
                  <li key={i} className="flex items-start gap-2"><X className="h-3 w-3 text-warning mt-0.5 shrink-0" />{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-info">Recommendations</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs list-disc list-inside text-muted-foreground">
                {retro.recommendations.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
