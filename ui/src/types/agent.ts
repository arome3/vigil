export const AGENT_NAMES = [
  "vigil-coordinator",
  "vigil-triage",
  "vigil-investigator",
  "vigil-threat-hunter",
  "vigil-sentinel",
  "vigil-commander",
  "vigil-executor",
  "vigil-verifier",
  "vigil-analyst",
  "vigil-reporter",
  "vigil-chat",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export type AgentStatus = "active" | "waiting" | "completed" | "error" | "idle";

export interface Agent {
  name: AgentName;
  description: string;
  status: AgentStatus;
  tools: string[];
  a2a_connections: string[];
  tool_calls_today: number;
  avg_execution_time_ms: number;
}

export interface TraceNode {
  id: string;
  name: string;
  type: "agent" | "tool" | "wait";
  agent_name?: AgentName;
  duration_ms: number;
  status: "completed" | "in_progress" | "failed";
  children: TraceNode[];
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  start_time: string;
}

export interface AgentActivityEntry {
  id: string;
  timestamp: string;
  agent_name: AgentName;
  action_type: string;
  action_detail: string;
  incident_id?: string;
  execution_status: "completed" | "in_progress" | "failed";
  duration_ms?: number;
}
