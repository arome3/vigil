export const INCIDENT_STATUSES = [
  "detected",
  "triaged",
  "investigating",
  "threat_hunting",
  "planning",
  "awaiting_approval",
  "executing",
  "verifying",
  "reflecting",
  "resolved",
  "escalated",
  "suppressed",
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type IncidentType = "security" | "operational";

export interface AttackChainEntry {
  step: number;
  technique_id: string;
  technique_name: string;
  tactic: string;
  source: string;
  target: string;
  confidence: number;
  evidence_count: number;
}

export interface BlastRadiusEntry {
  asset_id: string;
  asset_name: string;
  asset_type: string;
  criticality: "tier-1" | "tier-2" | "tier-3";
  impact_type: string;
  confidence: number;
}

export interface ChangeCorrelation {
  matched: boolean;
  commit_sha: string;
  author: string;
  pr_number: number;
  pr_title: string;
  repo: string;
  time_gap_seconds: number;
  confidence: "high" | "medium" | "low";
  files_changed: string[];
}

export interface RemediationAction {
  order: number;
  action_type: "containment" | "remediation" | "communication" | "documentation";
  description: string;
  target_system: string;
  approval_required: boolean;
  status: "pending" | "executing" | "completed" | "failed";
  execution_time_ms?: number;
}

export interface SuccessCriterion {
  metric: string;
  operator: "lt" | "gt" | "eq" | "lte" | "gte";
  threshold: number;
  service_name: string;
}

export interface CriterionResult extends SuccessCriterion {
  current_value: number;
  passed: boolean;
}

export interface TimingMetrics {
  time_to_detect_seconds: number;
  time_to_investigate_seconds: number;
  time_to_remediate_seconds: number;
  time_to_verify_seconds: number;
  total_duration_seconds: number;
}

export interface Investigation {
  investigation_id: string;
  root_cause: string;
  attack_chain: AttackChainEntry[];
  blast_radius: BlastRadiusEntry[];
  change_correlation?: ChangeCorrelation;
  mitre_techniques: string[];
  recommended_next: "threat_hunt" | "plan_remediation" | "escalate";
}

export interface RemediationPlan {
  actions: RemediationAction[];
  success_criteria: SuccessCriterion[];
}

export interface Verification {
  iteration: number;
  health_score: number;
  passed: boolean;
  criteria_results: CriterionResult[];
  failure_analysis?: string;
}

export interface ExternalLinks {
  jira_ticket?: string;
  slack_thread?: string;
  pagerduty_incident?: string;
  github_pr?: string;
  github_commit?: string;
}

export interface Incident {
  id: string;
  status: IncidentStatus;
  severity: Severity;
  type: IncidentType;
  title: string;
  priority_score: number;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
  timing_metrics?: TimingMetrics;
  investigation?: Investigation;
  remediation_plan?: RemediationPlan;
  verification?: Verification;
  affected_assets: BlastRadiusEntry[];
  external_links?: ExternalLinks;
  reflection_count: number;
  current_agent?: string;
  _state_timestamps?: Record<string, string>;
}
