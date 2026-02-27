import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { Agent, AgentName } from "@/types/agent";

export const dynamic = "force-dynamic";

const AGENT_DESCRIPTIONS: Record<string, string> = {
  "vigil-coordinator": "Orchestrates the full incident pipeline and delegates to specialized agents",
  "vigil-triage": "Scores and prioritizes incoming alerts, suppresses false positives",
  "vigil-investigator": "Traces attack chains, maps MITRE techniques, determines root cause",
  "vigil-threat-hunter": "Sweeps for lateral movement, data exfiltration, and IOC matches",
  "vigil-sentinel": "Monitors operational metrics for anomalies beyond baseline thresholds",
  "vigil-commander": "Plans remediation using runbooks and impact assessment",
  "vigil-executor": "Fires Elastic Workflows with approval gates for critical actions",
  "vigil-verifier": "Validates resolution via health score comparison against success criteria",
  "vigil-analyst": "Calibrates triage weights, generates runbooks, tunes thresholds",
  "vigil-reporter": "Generates daily summaries, trend reports, and compliance evidence",
  "vigil-chat": "Natural language Kibana assistant for incident Q&A",
};

export async function GET() {
  try {
    // Get latest telemetry per agent
    const result = await client.search({
      index: "vigil-agent-telemetry",
      size: 0,
      aggs: {
        by_agent: {
          terms: { field: "agent_name", size: 20 },
          aggs: {
            latest: { top_hits: { size: 1, sort: [{ "@timestamp": "desc" }] } },
            tool_count: { value_count: { field: "tool_name" } },
            avg_duration: { avg: { field: "duration_ms" } },
          },
        },
      },
    });

    const aggs = result.aggregations as Record<string, { buckets: Record<string, unknown>[] }>;
    const buckets = aggs?.by_agent?.buckets ?? [];

    const seenAgents = new Set<string>();
    const agents: Agent[] = [];

    for (const bucket of buckets) {
      const name = bucket.key as string;
      seenAgents.add(name);
      const toolCount = (bucket.tool_count as { value: number })?.value ?? 0;
      const avgDuration = (bucket.avg_duration as { value: number | null })?.value ?? 0;

      agents.push({
        name: name as AgentName,
        description: AGENT_DESCRIPTIONS[name] ?? "",
        status: "idle",
        tools: [],
        a2a_connections: [],
        tool_calls_today: toolCount,
        avg_execution_time_ms: Math.round(avgDuration),
      });
    }

    // Fill in agents with no telemetry
    for (const [name, desc] of Object.entries(AGENT_DESCRIPTIONS)) {
      if (!seenAgents.has(name)) {
        agents.push({
          name: name as AgentName,
          description: desc,
          status: "idle",
          tools: [],
          a2a_connections: [],
          tool_calls_today: 0,
          avg_execution_time_ms: 0,
        });
      }
    }

    return NextResponse.json(agents);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
