import type { AgentActivityEntry } from "@/types/agent";

/** Timeline entries for incident INC-2026-00142 (Compromised API Key) */
export const mockTimelineEntries: AgentActivityEntry[] = [
  {
    id: "tle-001",
    timestamp: "2026-02-17T10:30:43Z",
    agent_name: "vigil-triage",
    action_type: "triage",
    action_detail:
      "Alert enriched — priority score: 0.92. Asset srv-payment-01 is tier-1 critical. Historical FP rate for this rule: 2.1%. Geo-anomaly flag: source IP 203.0.113.42 not in known-good list.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 43000,
  },
  {
    id: "tle-002",
    timestamp: "2026-02-17T10:31:02Z",
    agent_name: "vigil-investigator",
    action_type: "investigation",
    action_detail:
      "Attack chain traced — T1552 (credential access) \u2192 T1071 (C2 communication) \u2192 T1041 (data exfiltration). 3 assets in blast radius. Estimated 50MB exfiltrated to 198.51.100.10.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 262000,
  },
  {
    id: "tle-003",
    timestamp: "2026-02-17T10:31:47Z",
    agent_name: "vigil-threat-hunter",
    action_type: "threat_hunt",
    action_detail:
      "Environment sweep complete — 3 assets confirmed compromised, 2 additional assets flagged as suspected lateral movement targets. IOC sweep matched 7 indicators across 4 hosts.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 293000,
  },
  {
    id: "tle-004",
    timestamp: "2026-02-17T10:31:50Z",
    agent_name: "vigil-commander",
    action_type: "planning",
    action_detail:
      "Remediation plan generated — 5 actions: block IP 203.0.113.42, disable svc-payment account, rotate API keys, notify Slack, create Jira SEC-4521. Matched runbook: RB-SEC-012 (API Key Compromise).",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 45000,
  },
  {
    id: "tle-005",
    timestamp: "2026-02-17T10:33:12Z",
    agent_name: "vigil-executor",
    action_type: "execution",
    action_detail:
      "Plan executed — 5/5 actions completed. Block IP: 1.2s, disable account: 0.8s, rotate keys: 3.5s, Slack notify: 0.4s, Jira ticket: 0.6s. Total execution: 6.5s.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 150000,
  },
  {
    id: "tle-006",
    timestamp: "2026-02-17T10:34:12Z",
    agent_name: "vigil-verifier",
    action_type: "verification",
    action_detail:
      "Resolution verified — health score 0.95. All 3 success criteria passed: error_rate 0.08% < 0.5%, latency_p99 42ms < 200ms, blocked IP connections = 0.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 75000,
  },
];

/** Activity feed — recent entries from various agents across both incidents */
export const mockActivityFeed: AgentActivityEntry[] = [
  {
    id: "af-001",
    timestamp: "2026-02-17T11:05:47Z",
    agent_name: "vigil-verifier",
    action_type: "verification",
    action_detail:
      "Resolution verified for INC-2026-00143 — health score 0.92. All services recovered after rollback.",
    incident_id: "INC-2026-00143",
    execution_status: "completed",
    duration_ms: 60000,
  },
  {
    id: "af-002",
    timestamp: "2026-02-17T11:04:47Z",
    agent_name: "vigil-executor",
    action_type: "execution",
    action_detail:
      "Rollback executed for api-gateway. Deployment reverted from v2.14.3 to v2.14.2. Downstream pods restarted.",
    incident_id: "INC-2026-00143",
    execution_status: "completed",
    duration_ms: 75000,
  },
  {
    id: "af-003",
    timestamp: "2026-02-17T11:02:15Z",
    agent_name: "vigil-commander",
    action_type: "planning",
    action_detail:
      "Remediation plan generated — 4 actions: rollback deployment, restart pods, notify Slack, create Jira OPS-1893.",
    incident_id: "INC-2026-00143",
    execution_status: "completed",
    duration_ms: 23000,
  },
  {
    id: "af-004",
    timestamp: "2026-02-17T11:01:49Z",
    agent_name: "vigil-investigator",
    action_type: "investigation",
    action_detail:
      "Change correlation matched — commit a3f8c21 by j.martinez (PR #847) deployed 42s before error spike. Header validation change identified.",
    incident_id: "INC-2026-00143",
    execution_status: "completed",
    duration_ms: 65000,
  },
  {
    id: "af-005",
    timestamp: "2026-02-17T11:00:42Z",
    agent_name: "vigil-triage",
    action_type: "triage",
    action_detail:
      "Alert enriched — priority score: 0.78. Error rate spike across 4 services. Correlated with recent deployment activity.",
    incident_id: "INC-2026-00143",
    execution_status: "completed",
    duration_ms: 42000,
  },
  {
    id: "af-006",
    timestamp: "2026-02-17T10:59:30Z",
    agent_name: "vigil-sentinel",
    action_type: "monitoring",
    action_detail:
      "Anomaly detected — api-gateway error_rate spiked to 12.4% (baseline 0.1%). Dependency cascade detected across 3 downstream services.",
    incident_id: "INC-2026-00143",
    execution_status: "completed",
    duration_ms: 200,
  },
  {
    id: "af-007",
    timestamp: "2026-02-17T10:34:12Z",
    agent_name: "vigil-verifier",
    action_type: "verification",
    action_detail:
      "Resolution verified for INC-2026-00142 — health score 0.95. All success criteria passed.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 75000,
  },
  {
    id: "af-008",
    timestamp: "2026-02-17T10:33:12Z",
    agent_name: "vigil-executor",
    action_type: "execution",
    action_detail:
      "Remediation plan executed — 5/5 actions completed successfully. Source IP blocked, account disabled, keys rotated.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 150000,
  },
  {
    id: "af-009",
    timestamp: "2026-02-17T10:32:05Z",
    agent_name: "vigil-coordinator",
    action_type: "state_transition",
    action_detail:
      "Approval received for INC-2026-00142 remediation plan. Transitioning to executing state.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 150,
  },
  {
    id: "af-010",
    timestamp: "2026-02-17T10:31:50Z",
    agent_name: "vigil-commander",
    action_type: "planning",
    action_detail:
      "Remediation plan generated for INC-2026-00142 — 5 actions, matched runbook RB-SEC-012.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 45000,
  },
  {
    id: "af-011",
    timestamp: "2026-02-17T10:31:47Z",
    agent_name: "vigil-threat-hunter",
    action_type: "threat_hunt",
    action_detail:
      "IOC sweep found 7 indicators across 4 hosts. 2 additional suspected compromised assets identified.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 293000,
  },
  {
    id: "af-012",
    timestamp: "2026-02-17T10:31:02Z",
    agent_name: "vigil-investigator",
    action_type: "investigation",
    action_detail:
      "Attack chain traced for INC-2026-00142 — T1552 \u2192 T1071 \u2192 T1041. 3 assets in blast radius.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 262000,
  },
  {
    id: "af-013",
    timestamp: "2026-02-17T10:30:43Z",
    agent_name: "vigil-triage",
    action_type: "triage",
    action_detail:
      "Alert enriched for INC-2026-00142 — priority score: 0.92. Critical payment service asset.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 43000,
  },
  {
    id: "af-014",
    timestamp: "2026-02-17T10:30:00Z",
    agent_name: "vigil-coordinator",
    action_type: "state_transition",
    action_detail:
      "New alert detected — INC-2026-00142. Severity: critical. Delegating to vigil-triage.",
    incident_id: "INC-2026-00142",
    execution_status: "completed",
    duration_ms: 100,
  },
  {
    id: "af-015",
    timestamp: "2026-02-17T10:28:00Z",
    agent_name: "vigil-sentinel",
    action_type: "monitoring",
    action_detail:
      "Health check cycle completed — all 14 monitored services within normal parameters. Next check in 30s.",
    execution_status: "completed",
    duration_ms: 180,
  },
];
