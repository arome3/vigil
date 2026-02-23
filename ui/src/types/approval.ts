export interface ApprovalRequest {
  approval_id: string;
  incident_id: string;
  incident_title: string;
  severity: string;
  proposed_action: string;
  impact_assessment: string;
  investigation_summary: string;
  runbook_reference?: string;
  evidence?: Record<string, unknown>;
  timeout_at: string;
  created_at: string;
}

export interface ApprovalResponse {
  approval_id: string;
  decision: "approved" | "rejected" | "more_info";
  responder: string;
  responded_at: string;
  notes?: string;
}
