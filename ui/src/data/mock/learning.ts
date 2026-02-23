import type {
  LearningRecord,
  Retrospective,
} from "@/types/learning";

export const mockLearningRecords: LearningRecord[] = [
  {
    id: "LRN-2026-001",
    type: "triage_calibration",
    status: "applied",
    title: "Adjust geo-anomaly scoring weight",
    description:
      "Geo-anomaly flag for payment-service source IPs was weighted too low (0.15). After INC-2026-00142, analysis shows geo-anomaly correlates with true positives at 0.89 rate for tier-1 financial assets. Weight increased to 0.35.",
    confidence: 0.89,
    incident_id: "INC-2026-00142",
    created_at: "2026-02-17T11:00:00Z",
    applied_at: "2026-02-17T12:30:00Z",
    analysis: {
      previous_weight: 0.15,
      new_weight: 0.35,
      supporting_incidents: 7,
      false_positive_reduction_estimate: "12%",
    },
  },
  {
    id: "LRN-2026-002",
    type: "threshold_tuning",
    status: "pending",
    title: "Lower anomaly \u03c3 threshold for payment services",
    description:
      "Current anomaly detection threshold for payment-service error_rate is 3\u03c3. INC-2026-00142 was detected at 2.8\u03c3. Recommend lowering to 2.5\u03c3 for tier-1 payment assets to improve early detection.",
    confidence: 0.76,
    incident_id: "INC-2026-00142",
    created_at: "2026-02-17T11:15:00Z",
    analysis: {
      current_threshold_sigma: 3.0,
      proposed_threshold_sigma: 2.5,
      estimated_additional_alerts_per_day: 2,
      estimated_fp_increase: "4%",
      detection_improvement_estimate: "18s faster TTD",
    },
  },
  {
    id: "LRN-2026-003",
    type: "runbook_generation",
    status: "applied",
    title: "Auto-generated runbook: API key compromise response",
    description:
      "Generated runbook RB-SEC-012-v2 based on successful remediation of INC-2026-00142. Covers credential rotation, IP blocking, session revocation, and post-incident verification steps specific to payment-service infrastructure.",
    confidence: 0.92,
    incident_id: "INC-2026-00142",
    created_at: "2026-02-17T11:30:00Z",
    applied_at: "2026-02-17T13:00:00Z",
    analysis: {
      runbook_id: "RB-SEC-012-v2",
      steps_count: 8,
      based_on_incidents: ["INC-2026-00142", "INC-2026-00098"],
      estimated_mttr_improvement: "15%",
      approval_required_actions: ["rotate_keys", "block_ip_range"],
    },
  },
  {
    id: "LRN-2026-004",
    type: "attack_pattern",
    status: "pending",
    title: "Credential access \u2192 exfiltration pattern cluster detected",
    description:
      "Clustering analysis identified a recurring pattern: T1552 (credential access) followed by T1071 (C2 setup) and T1041 (exfiltration) within 2-hour windows. 3 incidents in the last 30 days match this pattern, suggesting a coordinated campaign targeting service accounts.",
    confidence: 0.71,
    incident_id: "INC-2026-00142",
    created_at: "2026-02-17T12:00:00Z",
    analysis: {
      pattern_hash: "pat-cred-exfil-001",
      technique_sequence: ["T1552", "T1071", "T1041"],
      matching_incidents: [
        "INC-2026-00142",
        "INC-2026-00098",
        "INC-2026-00087",
      ],
      time_window_hours: 2,
      target_commonality: "service_accounts",
      recommended_hunt_query:
        'source.ip IN threat_intel_list AND event.action == "api_key_usage"',
    },
  },
  {
    id: "LRN-2026-005",
    type: "retrospective",
    status: "applied",
    title: "INC-2026-00142 post-incident analysis",
    description:
      "Full retrospective on compromised API key incident. Total resolution time 252s (4m12s). All agents performed within expected parameters. Key finding: 60s verification wait could be reduced to 30s for tier-1 services with real-time health streaming enabled.",
    confidence: 0.95,
    incident_id: "INC-2026-00142",
    created_at: "2026-02-17T12:30:00Z",
    applied_at: "2026-02-17T14:00:00Z",
    analysis: {
      total_duration_seconds: 252,
      agent_count: 6,
      tools_invoked: 18,
      reflection_loops: 0,
      optimization_opportunities: [
        "Reduce verification wait for tier-1 services",
        "Parallel execution of containment actions",
        "Pre-cache threat intel for known service accounts",
      ],
    },
  },
];

export const mockRetrospective: Retrospective = {
  id: "RETRO-2026-00142",
  incident_id: "INC-2026-00142",
  title:
    "Retrospective: Compromised API key — external data exfiltration from payment service",
  created_at: "2026-02-17T12:30:00Z",
  timeline_summary:
    "Alert detected at 10:30:00Z. Triage completed in 43s with priority score 0.92. Investigation traced a 3-step attack chain (T1552 \u2192 T1071 \u2192 T1041) in 4m22s. Threat hunt confirmed 3 compromised and 2 suspected assets. Commander produced a 5-action plan in 45s. Executor completed all actions in 2m30s. Verifier confirmed resolution after 60s stabilization wait with health score 0.95. Total pipeline duration: 4m12s.",
  total_duration_seconds: 252,
  agent_performance: [
    {
      agent_name: "vigil-triage",
      tools_called: 3,
      reasoning_time_ms: 43000,
      status: "completed",
      accuracy_score: 0.96,
    },
    {
      agent_name: "vigil-investigator",
      tools_called: 6,
      reasoning_time_ms: 262000,
      status: "completed",
      accuracy_score: 0.93,
    },
    {
      agent_name: "vigil-threat-hunter",
      tools_called: 2,
      reasoning_time_ms: 293000,
      status: "completed",
      accuracy_score: 0.90,
    },
    {
      agent_name: "vigil-commander",
      tools_called: 2,
      reasoning_time_ms: 45000,
      status: "completed",
      accuracy_score: 0.94,
    },
    {
      agent_name: "vigil-executor",
      tools_called: 5,
      reasoning_time_ms: 150000,
      status: "completed",
      accuracy_score: 1.0,
    },
    {
      agent_name: "vigil-verifier",
      tools_called: 2,
      reasoning_time_ms: 75000,
      status: "completed",
      accuracy_score: 0.95,
    },
  ],
  what_went_well: [
    "Triage correctly prioritized the alert at 0.92 — no false positive hesitation despite the rule having a 2.1% historical FP rate",
    "Attack chain was fully traced in a single investigation pass with no reflection loops needed",
    "All 5 remediation actions executed successfully on the first attempt with zero failures",
    "Verification confirmed resolution in a single iteration — health score 0.95 exceeded the 0.85 threshold",
    "End-to-end resolution in 252 seconds (4m12s) is well below the 10-minute SLA for critical incidents",
  ],
  needs_improvement: [
    "The 60-second verification stabilization wait is conservative for tier-1 services — real-time health streaming could reduce this to 30s",
    "Threat hunter ran in parallel with investigation but took longer (293s vs 262s) — could start earlier with partial triage data",
    "Containment actions (block IP, disable account) were executed sequentially — parallel execution could save 0.8s",
    "No automated notification to the asset owner team (payments) — only the general #vigil-incidents channel was notified",
  ],
  recommendations: [
    "Enable real-time health streaming for tier-1 services to halve the verification wait time",
    "Implement parallel containment execution for independent actions (block IP + disable account can run concurrently)",
    "Add asset-owner notification as a standard communication action in security incident runbooks",
    "Schedule proactive IOC sweeps every 6 hours for payment-related service accounts based on the detected attack pattern cluster",
    "Consider lowering the anomaly detection threshold from 3\u03c3 to 2.5\u03c3 for tier-1 payment assets to improve TTD",
  ],
};
