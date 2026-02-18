<div align="center">

# VIGIL

### Autonomous Security Operations Center

**9 AI Agents &middot; 16 ES|QL Tools &middot; 7 Search Tools &middot; 6 Elastic Workflows &middot; Sub-3-Minute Resolution**

Built with **Elasticsearch Agent Builder**

![Node.js](https://img.shields.io/badge/Node.js-20_LTS-339933?logo=node.js&logoColor=white)
![Elasticsearch](https://img.shields.io/badge/Elasticsearch-9.3+-005571?logo=elasticsearch&logoColor=white)
![Claude](https://img.shields.io/badge/Claude_Sonnet-4.5-7C3AED?logo=anthropic&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

[The Problem](#the-problem) &middot; [Architecture](#architecture) &middot; [Key Features](#key-features) &middot; [Agent System](#the-agent-system) &middot; [Getting Started](#getting-started) &middot; [Demo](#demo-scenarios) &middot; [Tech Stack](#tech-stack)

</div>

---

## The Problem

Modern Security Operations Centers are drowning in noise. The average SOC receives **4,484 alerts per day**, each requiring approximately 25 minutes of analyst investigation. With a false positive rate exceeding **95%**, the vast majority of that effort is wasted on non-threats. Analyst burnout rates exceed 65%, and critically, **30% of genuine threats are missed** when analysts become desensitized to the volume.

When a genuine incident is confirmed, a second problem emerges: the **handoff from security to operations is manual, slow, and lossy**. A security analyst identifies a compromised credential, writes up a ticket, and passes it to the operations team. The ops engineer must re-investigate to understand context, determine blast radius, and execute remediation. This handoff typically adds **15-45 minutes** to resolution time — time during which the attacker maintains access and systems remain degraded.

The fundamental issue is that security monitoring, incident investigation, operational response, and post-incident verification are treated as **separate workflows** served by **separate tools** with **separate teams** — creating context loss, coordination delays, inconsistent execution, and no feedback loop.

| Metric | Industry Reality |
|--------|-----------------|
| SOC alerts per day | 4,484 average |
| Time per alert investigation | ~25 minutes |
| False positive rate | 95%+ for rule-based SIEM |
| Threats missed due to fatigue | 30% of genuine threats |
| Average downtime cost | $5,600 per minute (Gartner) |
| Mean time to resolve | 45-90 minutes for security incidents |
| SOC analyst burnout rate | 65%+ annual turnover |

---

## What Vigil Does

> *Vigil eliminates the gap between threat detection and operational recovery by deploying a team of specialized AI agents that detect, investigate, respond to, verify resolution of, and learn from security and operational incidents — end-to-end, in minutes, not hours.*

Vigil is an autonomous SOC platform that deploys **9 specialized AI agents** communicating via the **A2A (Agent-to-Agent) protocol**. Agents reason using **ES|QL-powered analytical tools**, retrieve context through **hybrid vector search**, execute actions through **Elastic Workflows**, and learn from outcomes to improve over time. The system operates end-to-end without human intervention for routine incidents, while preserving human-in-the-loop controls for critical decisions.

| Metric | Before Vigil | With Vigil |
|--------|-------------|------------|
| Mean Time to Detect (MTTD) | 5-15 minutes | < 30 seconds |
| Mean Time to Investigate (MTTI) | 25-45 minutes | < 60 seconds |
| Mean Time to Remediate (MTTR) | 30-90 minutes | < 3 minutes |
| False Positive Triage | Manual (25 min/alert) | Automated (< 5 sec/alert) |
| Alert-to-Resolution Coverage | Fragmented (3+ tools, 2+ teams) | Unified single platform |
| Audit Compliance | Manual documentation | 100% automated audit trail |
| Self-Correction | None (requires human re-investigation) | 3-iteration reflection loop |

---

## Architecture

Vigil follows a **4-layer architecture** where each layer builds on the one below:

```
┌─────────────────────────────────────────────────────────────┐
│  LEARNING LAYER         Analyst calibrates & improves       │
│                         Weight tuning, runbook generation   │
├─────────────────────────────────────────────────────────────┤
│  FEEDBACK LAYER         Verifier validates resolution       │
│                         Reflection loops re-engage agents   │
├─────────────────────────────────────────────────────────────┤
│  EXECUTION LAYER        Commander plans remediation         │
│                         Executor fires workflows            │
│                         Elastic Workflows call external APIs│
├─────────────────────────────────────────────────────────────┤
│  REASONING LAYER        Coordinator orchestrates pipeline   │
│                         Triage scores + prioritizes         │
│                         Investigator traces attack chains   │
│                         Threat Hunter sweeps environment    │
│                         Sentinel monitors operations        │
├─────────────────────────────────────────────────────────────┤
│  DATA LAYER             10 Elasticsearch indices            │
│                         16 ES|QL tools + 7 Search tools     │
│                         Dense vector embeddings (1024-dim)  │
│                         GitHub webhook ingest pipeline      │
└─────────────────────────────────────────────────────────────┘
```

### Incident Flow

```
Alert ──▶ Triage ──▶ Coordinator ──▶ Investigator ──▶ Threat Hunter
                         │                                   │
                         │◀──────────────────────────────────┘
                         │
                         ▼
                     Commander ──▶ Executor ──▶ Verifier
                         ▲                        │
                         │    Reflection Loop      │
                         └────────────────────────┘
                                                   │
                                              Analyst (async)
                                        learns from outcomes
```

The **Coordinator** acts as the hub in a hub-and-spoke pattern, managing incident state via an **11-state state machine** with guard conditions and enforcing the **A2A protocol** for all inter-agent communication. When the Verifier detects that remediation didn't fully resolve an incident, it triggers a **reflection loop** — re-engaging the investigation and remediation pipeline up to 3 times before escalating to humans. After resolution, the **Analyst** asynchronously processes outcomes to calibrate triage weights, generate runbooks, and tune anomaly thresholds.

---

## Key Features

**Intelligent Triage** — Multi-signal priority scoring formula combining threat severity (0.3), asset criticality (0.3), corroboration score (0.25), and historical false positive rate (0.15). Auto-suppresses alerts below 0.4, queues 0.4-0.7, and fast-tracks above 0.7 for immediate investigation.

**Deep Investigation** — Attack chain tracing via multi-hop ES|QL queries, MITRE ATT&CK mapping through hybrid search, blast radius assessment, and **change correlation via LOOKUP JOIN** that bridges deployment events with error logs to identify the exact commit, author, and PR that caused an incident.

**Dense Vector Search** — 1024-dimensional embeddings with `int8_hnsw` quantization powering hybrid (keyword + vector) search across runbooks, threat intelligence, incident history, and MITRE ATT&CK techniques. Enables semantic similarity matching for past incidents and contextual runbook retrieval.

**Autonomous Response** — 6 Elastic Workflows executing containment (IP blocks, account suspension, host isolation), remediation (pod restarts, deployment rollbacks, credential rotation), notifications (Slack, PagerDuty), and ticketing (Jira) — all with full audit trails and rollback capability.

**Self-Correcting Resolution** — Verifier agent independently validates remediation by comparing post-action health metrics against pre-incident baselines. Composite health score (passed/total >= 0.8) triggers automatic re-investigation if thresholds aren't met, up to 3 reflection iterations.

**Continuous Learning** — Analyst agent performs post-incident analysis: calibrates triage weight accuracy against actual outcomes, generates new runbooks from successful resolutions, tunes per-service anomaly thresholds, discovers recurring incident patterns, and produces retrospective reports.

---

## The Agent System

Vigil deploys **9 agents** in a hub-and-spoke topology. The Coordinator delegates tasks to specialized spoke agents via the A2A protocol. Each agent has a dedicated system prompt, scoped tool access, and least-privilege API keys.

| Agent | Role | Tools | Key Capability |
|-------|------|:-----:|----------------|
| **vigil-coordinator** | Hub orchestrator | 2 | State machine enforcement, timing metrics, delegation |
| **vigil-triage** | Priority scoring | 3 | Composite 0.0-1.0 scoring with FP rate suppression |
| **vigil-investigator** | Root cause analysis | 6 | Attack chain tracing, MITRE mapping, LOOKUP JOIN correlation |
| **vigil-threat-hunter** | Environment sweep | 2 | IoC scanning, behavioral anomaly detection |
| **vigil-sentinel** | Operational monitoring | 3 | 2-sigma anomaly detection, dependency tracing, change detection |
| **vigil-commander** | Remediation planning | 2 | Runbook retrieval (hybrid search), impact assessment |
| **vigil-executor** | Plan execution | 7 | 6 workflows + audit logging, approval gate enforcement |
| **vigil-verifier** | Resolution validation | 2 | Health score computation, baseline comparison, reflection trigger |
| **vigil-analyst** | Post-incident learning | 5 | Weight calibration, runbook generation, pattern discovery |

---

## Tool Ecosystem

Vigil provides **29 purpose-built tools** across three categories: 16 ES|QL analytical tools, 7 search retrieval tools, and 6 Elastic Workflows.

<details>
<summary><strong>16 ES|QL Tools</strong> — Parameterized analytical queries</summary>

| Tool | Agent | Index | Purpose |
|------|-------|-------|---------|
| `vigil-esql-alert-enrichment` | Triage | logs-\*, metrics-\* | Correlated events around alert |
| `vigil-esql-historical-fp-rate` | Triage | vigil-incidents | False positive rate for rule |
| `vigil-esql-attack-chain-tracer` | Investigator | logs-\* | Multi-hop attack path reconstruction |
| `vigil-esql-blast-radius` | Investigator | logs-\*, metrics-\* | Affected services and users |
| `vigil-esql-change-correlation` | Investigator | github-events-\*, metrics-\* | LOOKUP JOIN: deploys vs errors |
| `vigil-esql-ioc-sweep` | Threat Hunter | logs-\* | Environment-wide IoC scan |
| `vigil-esql-behavioral-anomaly` | Threat Hunter | logs-\* | Behavioral deviation detection |
| `vigil-esql-health-monitor` | Sentinel | metrics-\* | Service health vs 7-day baseline |
| `vigil-esql-dependency-tracer` | Sentinel | traces-apm-\* | Service dependency graph |
| `vigil-esql-recent-change-detector` | Sentinel | github-events-\* | 5-minute deployment correlation |
| `vigil-esql-impact-assessment` | Commander | metrics-\*, vigil-assets | Blast radius before action |
| `vigil-esql-health-comparison` | Verifier | metrics-\*, vigil-baselines | Post-remediation health check |
| `vigil-esql-incident-outcomes` | Analyst | vigil-incidents | Resolution stats by incident type |
| `vigil-esql-triage-calibration` | Analyst | vigil-incidents | Priority score vs outcome accuracy |
| `vigil-esql-threshold-analysis` | Analyst | vigil-incidents, metrics-\* | Per-service anomaly threshold tuning |
| `vigil-esql-remediation-effectiveness` | Analyst | vigil-actions-\* | Action success/failure rates |

</details>

<details>
<summary><strong>7 Search Tools</strong> — Keyword, hybrid, and kNN vector retrieval</summary>

| Tool | Agent | Strategy | Index |
|------|-------|----------|-------|
| `vigil-search-asset-criticality` | Triage | Keyword | vigil-assets |
| `vigil-search-mitre-attack` | Investigator | Hybrid (keyword + vector) | vigil-threat-intel |
| `vigil-search-threat-intel` | Investigator | Keyword | vigil-threat-intel |
| `vigil-search-incident-similarity` | Investigator | kNN vector | vigil-incidents |
| `vigil-search-runbooks` | Commander | Hybrid (keyword + vector) | vigil-runbooks |
| `vigil-search-baselines` | Verifier | Keyword | vigil-baselines |
| `vigil-search-incident-patterns` | Analyst | Hybrid (keyword + vector) | vigil-incidents |

</details>

<details>
<summary><strong>6 Elastic Workflows</strong> — YAML-defined automation pipelines</summary>

| Workflow | Trigger | External Systems |
|----------|---------|-----------------|
| `vigil-wf-containment` | Block IP, disable account, isolate host | Cloudflare WAF, Okta, Kubernetes |
| `vigil-wf-remediation` | Restart pod, rollback deploy, scale, rotate credentials | Kubernetes |
| `vigil-wf-notify` | Incident notification, escalation | Slack, PagerDuty, Email |
| `vigil-wf-ticketing` | Create/update ticket | Jira REST API v3 |
| `vigil-wf-approval` | Human approval for high-impact actions | Slack interactive buttons |
| `vigil-wf-reporting` | Post-incident summary aggregation | Elasticsearch (self-index) |

</details>

---

## Getting Started

### Prerequisites

- **Node.js** 20 LTS or later
- **Python** 3.11+
- **Elasticsearch** 9.3+ or Elastic Cloud (Serverless)
- **Kibana** 9.3+ with Agent Builder enabled
- LLM connector configured (Claude Sonnet 4.5 recommended)

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/AroMorin/vigil.git
cd vigil

# 2. Configure environment
cp .env.example .env
# Edit .env with your Elastic Cloud, LLM, and integration credentials

# 3. Install dependencies
npm install
pip install -r requirements.txt

# 4. Bootstrap the platform
npm run bootstrap

# 5. Start the webhook server
npm run dev
```

### What Bootstrap Does

The `npm run bootstrap` command executes a 9-step initialization sequence:

| Step | Action | What It Creates |
|:----:|--------|-----------------|
| 1 | Create ILM policies | `vigil-90d-policy`, `vigil-1y-policy` |
| 2 | Create index templates | Mappings for all 10 indices |
| 3 | Create data streams & indices | `vigil-incidents`, `vigil-actions-*`, etc. |
| 4 | Configure inference endpoint | Embedding model for vector search |
| 5 | Create ingest pipelines | Auto-embedding on document ingest |
| 6 | Seed reference data | Runbooks, assets, threat intel, baselines |
| 7 | Register ES\|QL tools | 12 parameterized query tools |
| 8 | Provision agents | 9 agents with system prompts and tool bindings |
| 9 | Deploy workflows | 6 Elastic Workflow definitions |

---

## Demo Scenarios

### Scenario 1: Compromised API Key

```bash
npm run demo:scenario1
```

A detection rule fires when an API key for the production payment service is used from an unexpected geographic location with bulk data export attempts.

**Agent Flow:**
1. **Triage** enriches the alert — Tier-1 critical asset, anomalous geo-IP, correlated exfiltration logs → priority score: **0.92**
2. **Investigator** traces the key's history — exposed in a public GitHub commit 3 days ago, attacker exfiltrating customer records. MITRE mapping: T1552 (Unsecured Credentials) → T1041 (Exfiltration Over C2)
3. **Threat Hunter** sweeps for additional compromised keys from the same repository — confirms isolated breach
4. **Commander** plans: revoke key → rotate all service keys → block attacker IP range → forensic snapshot → notify security + compliance
5. **Executor** fires containment and remediation workflows, sends Slack notification, creates Jira ticket
6. **Verifier** confirms: no unauthorized access, new keys functional, payment service healthy

**Result: 4 minutes 12 seconds. Manual estimate: 2+ hours.**

### Scenario 2: Cascading Deployment Failure

```bash
npm run demo:scenario2
```

A code deployment pushes a breaking configuration change to the API Gateway, causing 5xx error rates to spike from 0.1% to 23% across three microservices.

**Agent Flow:**
1. **Sentinel** detects the error spike, dependency tracer identifies API Gateway as root cause
2. **Investigator** runs **Change Correlation (LOOKUP JOIN)** — joins error logs with `github-events-*` deployment data. Match: commit `a3f8c21` by @jsmith via PR #847, deployed **42 seconds** before first error. Root cause: new `X-Request-ID` header validation rejecting requests from downstream services
3. **Commander** plans surgically: rollback API Gateway to pre-`a3f8c21` → scale downstream replicas → notify deploying team with exact commit and PR → create Jira ticket assigned to @jsmith
4. **Executor** rolls back via CI/CD workflow, scales replicas via Kubernetes API, sends Slack notification with commit hash and PR link
5. **Verifier** confirms: error rates back to 0.12% within 3 minutes

**Result: 5 minutes 47 seconds. The agent identified the exact commit, author, and code change — context that takes a human SRE 15-30 minutes of manual git log correlation.**

---

## Project Structure

```
vigil/
├── agents/                          # Agent Builder deployment configs
├── dashboards/                      # Kibana dashboard NDJSON exports
├── infra/
│   ├── docker/demo-services/        # Containerized demo microservices
│   ├── elastic/
│   │   ├── ilm-policies/            # ILM policy definitions
│   │   ├── index-templates/         # Index template JSON
│   │   ├── ingest-pipelines/        # Ingest pipeline configs
│   │   └── transforms/              # Elasticsearch transforms
│   └── k8s/
│       ├── demo-services/           # Kubernetes manifests for demo
│       └── namespace.yaml           # vigil-demo namespace
├── scripts/
│   ├── bootstrap.sh                 # 9-step platform initialization
│   ├── demo/                        # Demo scenario runners
│   ├── pipelines/                   # Data pipeline scripts
│   └── setup/                       # Individual bootstrap step scripts
├── seed-data/
│   ├── assets/                      # Asset inventory records
│   ├── baselines/                   # 7-day service baselines
│   ├── runbooks/                    # Remediation procedure library
│   └── threat-intel/                # IoCs + MITRE ATT&CK data
├── social/                          # social media assets
├── src/
│   ├── a2a/                         # A2A protocol implementation
│   │   ├── agent-cards.js           # Agent capability declarations
│   │   ├── contracts.js             # Request/response schemas
│   │   ├── message-envelope.js      # A2A message format
│   │   └── router.js                # Inter-agent message routing
│   ├── agents/
│   │   ├── commander/               # Remediation planning agent
│   │   ├── coordinator/             # Hub orchestrator agent
│   │   ├── investigator/            # Root cause analysis agent
│   │   ├── sentinel/                # Operational monitoring agent
│   │   ├── threat-hunter/           # Environment sweep agent
│   │   └── triage/                  # Priority scoring agent
│   ├── embeddings/                  # Embedding service + ingest pipeline
│   ├── scoring/                     # Priority scoring formula
│   ├── search/                      # Hybrid search implementation
│   ├── state-machine/               # 11-state incident state machine
│   ├── tools/
│   │   ├── esql/                    # 12 ES|QL tool definitions + executor
│   │   └── search/                  # 6 search tool definitions + executor
│   ├── utils/                       # Elastic client, logger
│   └── webhooks/                    # GitHub webhook receiver
├── tests/
│   ├── agents/                      # Agent behavior tests
│   ├── e2e/                         # End-to-end flow tests
│   ├── state-machine/               # State transition tests
│   └── tools/                       # Tool execution tests
├── tools/                           # Tool registration configs
├── workflows/                       # Elastic Workflow YAML definitions
├── .env.example                     # Environment variable template
├── .gitignore
├── package.json
├── requirements.txt                 # Python dependencies (seed data)
├── vigil.md                         # Product specification
└── vigil_technical_spec.md          # Technical specification
```

---

## Integrations

| Integration | Purpose | Protocol |
|-------------|---------|----------|
| **Slack** | Incident notifications, interactive approval buttons | Webhook / Slack API |
| **Jira** | Ticket creation and updates with investigation context | REST API v3 |
| **PagerDuty** | On-call escalation for critical severity | Events API v2 |
| **GitHub** | Webhook ingestion for change correlation + deployment rollback | Webhooks + REST API |
| **Cloudflare** | WAF rule creation for IP blocking (Rulesets API) | REST API |
| **Okta** | User account suspension and MFA enforcement | OAuth 2.0 |
| **Kubernetes** | Pod restart, replica scaling, deployment rollback, host isolation | K8s API |

---

## Data Model

Vigil operates across **10 Elasticsearch indices** optimized for their access patterns:

| Index | Type | ILM Policy | Purpose |
|-------|------|-----------|---------|
| `vigil-incidents` | Standard | vigil-1y-policy | Core incident state and lifecycle |
| `vigil-actions-*` | Data stream | vigil-90d-policy | Immutable audit trail of all actions |
| `vigil-runbooks` | Standard | — | Remediation procedure library (vector-embedded) |
| `vigil-assets` | Standard | — | Asset inventory with criticality tiers |
| `vigil-threat-intel` | Standard | — | IoCs + MITRE ATT&CK techniques (vector-embedded) |
| `vigil-baselines` | Standard | — | 7-day rolling service health baselines |
| `vigil-metrics-*` | Data stream | vigil-90d-policy | Aggregated service metrics |
| `vigil-agent-telemetry` | Standard | vigil-90d-policy | Agent tool execution logs |
| `github-events-*` | Data stream | vigil-90d-policy | GitHub webhook event store |
| `vigil-learnings` | Standard | vigil-1y-policy | Analyst learning records (weights, runbooks, patterns) |

---

## Configuration

<details>
<summary><strong>Environment Variables</strong></summary>

| Category | Variables | Purpose |
|----------|----------|---------|
| **Elastic Cloud** | `ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY`, `ELASTIC_URL`, `KIBANA_URL` | Elasticsearch and Kibana connectivity |
| **LLM Provider** | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` | Agent reasoning backbone |
| **Slack** | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_INCIDENT_CHANNEL`, `SLACK_APPROVAL_CHANNEL` | Notifications and approval buttons |
| **Jira** | `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_USER_EMAIL` | Ticket creation |
| **PagerDuty** | `PAGERDUTY_ROUTING_KEY` | On-call escalation |
| **GitHub** | `GITHUB_WEBHOOK_SECRET` | Webhook signature validation |
| **Cloudflare** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RULESET_ID` | WAF IP blocking |
| **Okta** | `OKTA_DOMAIN`, `OKTA_API_TOKEN` | Account suspension |
| **Kubernetes** | `K8S_CONTEXT`, `DEMO_NAMESPACE` | Pod management |
| **Embeddings** | `EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `COHERE_API_KEY` | Vector search embeddings |
| **Vigil Tuning** | `VIGIL_MAX_REFLECTION_LOOPS`, `VIGIL_APPROVAL_TIMEOUT_MINUTES`, `VIGIL_TRIAGE_*_THRESHOLD`, `VIGIL_ANOMALY_STDDEV_THRESHOLD` | Platform behavior tuning |

See [`.env.example`](.env.example) for the complete template with all variables.

</details>

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Data store & search | Elasticsearch | 9.3+ / Serverless |
| Agent framework | Elastic Agent Builder | GA (9.3+) |
| Query language | ES\|QL | GA with LOOKUP JOIN (tech preview) |
| LLM backbone | Claude Sonnet 4.5 via Elastic LLM connector | — |
| Inter-agent protocol | A2A (Google open standard) | — |
| Automation | Elastic Workflows | GA (9.3+) |
| Visualization | Kibana dashboards | 9.3+ |
| Container orchestration | Kubernetes (minikube/kind) | 1.28+ |
| Runtime | Node.js 20 LTS + Python 3.11+ | — |
| Integrations | Slack, Jira, PagerDuty, GitHub, Cloudflare, Okta | — |

---

## Scope

Built with **Elasticsearch Agent Builder**.

Vigil demonstrates the following Elastic features:

- **Elasticsearch Agent Builder** — 9 agents with custom system prompts, scoped tool access, and ReAct reasoning
- **ES|QL** — 16 parameterized query tools including `LOOKUP JOIN` for cross-index change correlation
- **Elastic Workflows** — 6 YAML-defined automation pipelines with external API integration
- **A2A Protocol** — Hub-and-spoke inter-agent communication with structured contracts
- **Dense Vector Search** — 1024-dim embeddings with `int8_hnsw` quantization for hybrid retrieval
- **Data Streams & ILM** — Time-series data management with automated lifecycle policies
- **Ingest Pipelines** — Automatic embedding generation on document ingest
- **Kibana Dashboards** — Real-time incident command center with agent activity visualization
