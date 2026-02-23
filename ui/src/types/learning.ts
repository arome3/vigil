export type LearningType =
  | "triage_calibration"
  | "threshold_tuning"
  | "runbook_generation"
  | "attack_pattern"
  | "retrospective";

export type LearningStatus = "pending" | "applied" | "rejected" | "expired";

export interface LearningRecord {
  id: string;
  type: LearningType;
  status: LearningStatus;
  title: string;
  description: string;
  confidence: number;
  incident_id: string;
  created_at: string;
  applied_at?: string;
  analysis: Record<string, unknown>;
}

export interface Retrospective {
  id: string;
  incident_id: string;
  title: string;
  created_at: string;
  timeline_summary: string;
  total_duration_seconds: number;
  agent_performance: AgentPerformanceEntry[];
  what_went_well: string[];
  needs_improvement: string[];
  recommendations: string[];
}

export interface AgentPerformanceEntry {
  agent_name: string;
  tools_called: number;
  reasoning_time_ms: number;
  status: "completed" | "failed" | "skipped";
  accuracy_score?: number;
}
