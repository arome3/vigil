import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { LearningRecord } from "@/types/learning";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Try multiple possible index names
    let hits: Record<string, unknown>[] = [];
    for (const idx of ["vigil-learning-default", "vigil-learnings"]) {
      try {
        const result = await client.search({
          index: idx,
          size: 50,
          sort: [{ created_at: { order: "desc", unmapped_type: "date" } }],
        });
        hits = result.hits.hits as Record<string, unknown>[];
        if (hits.length > 0) break;
      } catch {
        continue;
      }
    }

    const records: LearningRecord[] = hits.map((hit) => {
      const s = hit._source as Record<string, unknown>;
      return {
        id: (hit._id as string) ?? "",
        type: (s.type as LearningRecord["type"]) ?? "retrospective",
        status: (s.status as LearningRecord["status"]) ?? "pending",
        title: (s.title as string) ?? "",
        description: (s.description as string) ?? "",
        confidence: (s.confidence as number) ?? 0,
        incident_id: (s.incident_id as string) ?? "",
        created_at: (s.created_at as string) ?? "",
        applied_at: s.applied_at as string | undefined,
        analysis: (s.analysis as Record<string, unknown>) ?? {},
      };
    });

    return NextResponse.json(records);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json([], { status: 200 });
  }
}
