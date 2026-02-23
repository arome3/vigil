import type { Agent } from "@/types/agent";

export const mockAgents: Agent[] = [
  {
    name: "vigil-coordinator",
    description:
      "Orchestrates the full incident lifecycle. Watches for new alerts, delegates to specialist agents, manages state transitions, and enforces deadlines.",
    status: "active",
    tools: ["vigil-tool-incident-state", "vigil-tool-incident-metrics"],
    a2a_connections: [
      "vigil-triage",
      "vigil-investigator",
      "vigil-threat-hunter",
      "vigil-sentinel",
      "vigil-commander",
      "vigil-executor",
      "vigil-verifier",
    ],
    tool_calls_today: 24,
    avg_execution_time_ms: 4200,
  },
  {
    name: "vigil-triage",
    description:
      "Enriches incoming alerts with asset criticality, historical false-positive rates, and contextual data. Produces a priority score to guide investigation depth.",
    status: "idle",
    tools: [
      "vigil-esql-alert-enrichment",
      "vigil-esql-historical-fp-rate",
      "vigil-search-asset-criticality",
    ],
    a2a_connections: [],
    tool_calls_today: 18,
    avg_execution_time_ms: 850,
  },
  {
    name: "vigil-investigator",
    description:
      "Deep-dives into triaged incidents. Traces attack chains, maps blast radius, correlates with MITRE ATT&CK techniques, and identifies root cause.",
    status: "idle",
    tools: [
      "vigil-esql-attack-chain-tracer",
      "vigil-esql-blast-radius",
      "vigil-esql-change-correlation",
      "vigil-search-mitre-attack",
      "vigil-search-threat-intel",
      "vigil-search-incident-similarity",
    ],
    a2a_connections: [],
    tool_calls_today: 42,
    avg_execution_time_ms: 3200,
  },
  {
    name: "vigil-threat-hunter",
    description:
      "Proactively sweeps the environment for indicators of compromise and behavioral anomalies related to the current incident.",
    status: "idle",
    tools: [
      "vigil-esql-ioc-sweep",
      "vigil-esql-behavioral-anomaly",
    ],
    a2a_connections: [],
    tool_calls_today: 12,
    avg_execution_time_ms: 5100,
  },
  {
    name: "vigil-sentinel",
    description:
      "Continuously monitors service health, dependency graphs, and recent changes. Fires alerts to the coordinator when anomalies cross thresholds.",
    status: "active",
    tools: [
      "vigil-esql-health-monitor",
      "vigil-esql-dependency-tracer",
      "vigil-esql-recent-change-detector",
    ],
    a2a_connections: ["vigil-coordinator"],
    tool_calls_today: 156,
    avg_execution_time_ms: 200,
  },
  {
    name: "vigil-commander",
    description:
      "Plans remediation by matching investigation findings to runbooks and assessing potential impact of proposed actions.",
    status: "idle",
    tools: [
      "vigil-search-runbooks",
      "vigil-esql-impact-assessment",
    ],
    a2a_connections: [],
    tool_calls_today: 8,
    avg_execution_time_ms: 1200,
  },
  {
    name: "vigil-executor",
    description:
      "Executes approved remediation plans by invoking containment, remediation, notification, and ticketing workflows in order.",
    status: "idle",
    tools: [
      "vigil-wf-containment",
      "vigil-wf-remediation",
      "vigil-wf-notify",
      "vigil-wf-ticketing",
      "vigil-wf-approval",
      "vigil-wf-reporting",
      "vigil-tool-audit-log",
    ],
    a2a_connections: [],
    tool_calls_today: 15,
    avg_execution_time_ms: 2800,
  },
  {
    name: "vigil-verifier",
    description:
      "Validates that remediation was successful by comparing post-action metrics against baselines and success criteria.",
    status: "idle",
    tools: [
      "vigil-esql-health-comparison",
      "vigil-search-baselines",
    ],
    a2a_connections: [],
    tool_calls_today: 10,
    avg_execution_time_ms: 1500,
  },
  {
    name: "vigil-analyst",
    description:
      "Performs retrospective analysis on resolved incidents. Identifies triage calibration issues, threshold drift, and remediation effectiveness patterns.",
    status: "idle",
    tools: [
      "vigil-esql-incident-outcomes",
      "vigil-esql-triage-calibration",
      "vigil-esql-threshold-analysis",
      "vigil-esql-remediation-effectiveness",
      "vigil-search-incident-patterns",
    ],
    a2a_connections: [],
    tool_calls_today: 6,
    avg_execution_time_ms: 8000,
  },
  {
    name: "vigil-reporter",
    description:
      "Generates executive summaries, compliance evidence, operational trend reports, and agent performance dashboards.",
    status: "idle",
    tools: [
      "vigil-report-executive-summary",
      "vigil-report-compliance-evidence",
      "vigil-report-operational-trends",
      "vigil-report-agent-performance",
      "vigil-report-incident-detail-export",
      "vigil-search-incidents-for-report",
    ],
    a2a_connections: [],
    tool_calls_today: 3,
    avg_execution_time_ms: 12000,
  },
  {
    name: "vigil-chat",
    description:
      "Natural language interface for SOC operators. Answers questions about incidents, agent activity, service health, and audit trails.",
    status: "idle",
    tools: [
      "vigil-chat-incident-lookup",
      "vigil-chat-incident-list",
      "vigil-chat-agent-activity",
      "vigil-chat-service-health",
      "vigil-chat-action-audit",
      "vigil-chat-triage-stats",
      "vigil-report-executive-summary",
      "vigil-report-incident-detail-export",
    ],
    a2a_connections: [],
    tool_calls_today: 28,
    avg_execution_time_ms: 400,
  },
];
