import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { AgentActivityEntry, AgentName } from "@/types/agent";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await client.search({
      index: "vigil-agent-telemetry",
      size: 50,
      sort: [{ "@timestamp": "desc" }],
    });

    const entries: AgentActivityEntry[] = result.hits.hits.map((hit) => {
      const s = hit._source as Record<string, unknown>;
      return {
        id: hit._id as string,
        timestamp: (s["@timestamp"] as string) ?? (s.timestamp as string) ?? "",
        agent_name: (s.agent_name as AgentName) ?? "vigil-coordinator",
        action_type: (s.action_type as string) ?? (s.tool_name as string) ?? "tool_call",
        action_detail: (s.detail as string) || (s.tool_name as string) || (s.action_type as string) || (s.agent_name as string) || "",
        incident_id: s.incident_id as string | undefined,
        execution_status: (s.status as "completed") ?? "completed",
        duration_ms: s.duration_ms as number | undefined,
      };
    });

    return NextResponse.json(entries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
