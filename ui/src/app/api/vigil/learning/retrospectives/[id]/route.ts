import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { Retrospective } from "@/types/learning";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    let hit: Record<string, unknown> | null = null;
    for (const idx of ["vigil-learning-default", "vigil-learnings"]) {
      try {
        const result = await client.get({ index: idx, id });
        hit = result as Record<string, unknown>;
        break;
      } catch {
        continue;
      }
    }

    if (!hit) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const s = hit._source as Record<string, unknown>;
    const retro: Retrospective = {
      id: hit._id as string,
      incident_id: (s.incident_id as string) ?? "",
      title: (s.title as string) ?? "",
      created_at: (s.created_at as string) ?? "",
      timeline_summary: (s.timeline_summary as string) ?? "",
      total_duration_seconds: (s.total_duration_seconds as number) ?? 0,
      agent_performance: ((s.agent_performance ?? []) as Record<string, unknown>[]).map((ap) => ({
        agent_name: (ap.agent_name as string) ?? "",
        tools_called: (ap.tools_called as number) ?? 0,
        reasoning_time_ms: (ap.reasoning_time_ms as number) ?? 0,
        status: (ap.status as "completed") ?? "completed",
        accuracy_score: ap.accuracy_score as number | undefined,
      })),
      what_went_well: (s.what_went_well as string[]) ?? [],
      needs_improvement: (s.needs_improvement as string[]) ?? [],
      recommendations: (s.recommendations as string[]) ?? [],
    };

    return NextResponse.json(retro);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
