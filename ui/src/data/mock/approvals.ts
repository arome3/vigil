import type { ApprovalRequest } from "@/types/approval";

export const mockApprovalRequest: ApprovalRequest = {
  approval_id: "APR-2026-0042",
  incident_id: "INC-2026-00142",
  incident_title:
    "Compromised API key — external data exfiltration from payment service",
  severity: "critical",
  proposed_action:
    "Execute 5-step remediation: block source IP 203.0.113.42, disable svc-payment account, rotate all API keys for payment-service, notify #vigil-incidents, create Jira SEC-4521",
  impact_assessment:
    "Blocking IP may affect legitimate traffic from same range. Key rotation requires 30s service restart.",
  investigation_summary:
    "Attack chain: T1552 (credential access) \u2192 T1071 (C2 communication) \u2192 T1041 (data exfiltration). 3 assets in blast radius. Estimated 50MB data exfiltrated to 198.51.100.10.",
  runbook_reference: "RB-SEC-012 (API Key Compromise Response)",
  evidence: {
    attack_chain_length: 3,
    blast_radius_assets: 3,
    data_exfiltrated_mb: 50,
    c2_server: "198.51.100.10",
    source_ip: "203.0.113.42",
    compromised_account: "svc-payment",
  },
  timeout_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  created_at: new Date().toISOString(),
};
