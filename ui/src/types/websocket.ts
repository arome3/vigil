import type { Incident } from "./incident";
import type { AgentActivityEntry, TraceNode } from "./agent";
import type { ApprovalRequest } from "./approval";

export type WebSocketChannel = "incidents" | "agents" | "metrics" | "approvals";

export type WebSocketEvent =
  | { type: "incident.created"; data: Incident }
  | { type: "incident.state_changed"; data: { id: string; old_status: string; new_status: string; incident: Incident } }
  | { type: "incident.updated"; data: Incident }
  | { type: "agent.tool_started"; data: { incident_id: string; agent_name: string; tool_name: string; trace_node: TraceNode } }
  | { type: "agent.tool_completed"; data: { incident_id: string; agent_name: string; tool_name: string; trace_node: TraceNode } }
  | { type: "agent.delegated"; data: { incident_id: string; from_agent: string; to_agent: string } }
  | { type: "agent.activity"; data: AgentActivityEntry }
  | { type: "metrics.updated"; data: MetricsSnapshot }
  | { type: "approval.requested"; data: ApprovalRequest }
  | { type: "approval.responded"; data: { approval_id: string; decision: "approved" | "rejected" } }
  | { type: "approval.timeout"; data: { approval_id: string } };

export interface MetricsSnapshot {
  active_incidents: number;
  mttr_last_24h_seconds: number;
  alerts_suppressed_today: number;
  reflection_loops_triggered: number;
  sparklines: {
    active_incidents: number[];
    mttr: number[];
    suppressed: number[];
    reflections: number[];
  };
}

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
