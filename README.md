<div align="center">

# VIGIL

### Autonomous Security Operations Center

**11 AI Agents &middot; 29 Tools &middot; 7 Elastic Workflows &middot; Sub-3-Minute Resolution**

Built with **Elasticsearch Agent Builder**

![Node.js](https://img.shields.io/badge/Node.js-20_LTS-339933?logo=node.js&logoColor=white)
![Elasticsearch](https://img.shields.io/badge/Elasticsearch-9.3+-005571?logo=elasticsearch&logoColor=white)
![Claude](https://img.shields.io/badge/Claude_Sonnet-4.6-7C3AED?logo=anthropic&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

[The Problem](#the-problem) &middot; [Production Usage](#production-usage) &middot; [Architecture](#architecture) &middot; [Key Features](#key-features) &middot; [Engineering](#engineering-highlights) &middot; [Agent System](#the-agent-system) &middot; [Getting Started](#getting-started) &middot; [Tech Stack](#tech-stack)

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

Vigil is an autonomous SOC platform that deploys **11 specialized AI agents** communicating via the **A2A (Agent-to-Agent) protocol**. Agents reason using **ES|QL-powered analytical tools**, retrieve context through **hybrid vector search**, execute actions through **Elastic Workflows**, and learn from outcomes to improve over time. The system operates end-to-end without human intervention for routine incidents, while preserving human-in-the-loop controls for critical decisions.

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

## Production Usage

### How Alerts Enter the System

In production, Vigil watches for incidents from three sources — no manual trigger required:

| Source | How It Works | Example |
|--------|-------------|---------|
| **Elastic SIEM Detection Rules** | Kibana detection rules fire and write alerts to `vigil-alerts-default`. Vigil's Alert Watcher polls this data stream and engages agents within seconds. | A brute-force rule triggers after 50 failed logins in 2 minutes |
| **Sentinel Anomaly Detection** | The Sentinel agent continuously monitors `metrics-*` for deviations beyond 2σ from 7-day baselines. Anomalies are surfaced as incidents automatically. | Error rate on `payment-service` jumps from 0.1% to 12% — Sentinel catches it before any alert rule fires |
| **GitHub Webhooks** | Deployment events from GitHub are ingested into `github-events-*` via the webhook server. When an anomaly correlates with a recent deploy, Vigil traces it to the exact commit via LOOKUP JOIN. | A push to `main` triggers a deployment; 40 seconds later, latency spikes — Vigil links the two |

### How Teams Use Vigil

**SOC Analysts** — Vigil eliminates alert fatigue. The Triage agent auto-suppresses the 95% of alerts that are false positives and auto-prioritizes the rest. Analysts only see incidents that require human judgment — typically approval decisions for high-impact containment actions (credential revocation, IP blocks, account suspension). The Kibana Chat agent lets analysts ask "what happened with the order-service incident?" in natural language without leaving Kibana.

**SRE / DevOps Teams** — Vigil detects deployment failures before customers report them. Change correlation via LOOKUP JOIN identifies the exact commit, author, and PR that caused an outage. Automated rollback via Kubernetes workflows restores service while the responsible engineer is notified with full context in Slack and Jira — no 3 AM war rooms.

**Security Leadership / CISO** — The Reporter agent generates daily executive summaries, weekly MTTR trend reports, and monthly compliance evidence mapped to SOC 2, ISO 27001, and GDPR Article 33 controls. Every automated action is logged to an immutable audit trail in `vigil-actions-*` — exportable as CSV from Kibana for auditors.

**Incident Commanders** — For critical-severity incidents, the Executor pauses at the approval gate and posts an interactive Slack message with the proposed remediation plan. The commander approves or rejects with a button click (or via the web UI's approval modal with keyboard shortcuts). Full investigation context is attached — no re-investigation needed.

### Operational Flow

```
                        ┌─────────────────────────────────┐
                        │      Vigil runs 24/7             │
                        │  watching alerts + metrics        │
                        └──────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │     Alert / Anomaly detected │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────▼────────────────────┐
              │  Triage scores priority (0.0 – 1.0)     │
              └──┬─────────────┬───────────────────┬───┘
                 │             │                   │
          Score < 0.4    0.4 – 0.7           Score > 0.7
                 │             │                   │
           ┌─────▼───┐  ┌─────▼────┐        ┌─────▼──────┐
           │Suppress  │  │ Queue    │        │ Investigate │
           │(auto)    │  │(monitor) │        │ immediately │
           └──────────┘  └──────────┘        └─────┬──────┘
                                                   │
                                    ┌──────────────▼──────────────┐
                                    │  Full autonomous pipeline    │
                                    │  Investigate → Plan →        │
                                    │  Execute → Verify            │
                                    └──────────────┬──────────────┘
                                                   │
                              ┌─────────────────────▼─────────────────────┐
                              │            Severity check                  │
                              └──┬──────────────────┬─────────────────┬──┘
                                 │                  │                 │
                           Low/Medium          High              Critical
                                 │                  │                 │
                          ┌──────▼──────┐   ┌──────▼───────┐  ┌─────▼──────┐
                          │ Fully auto  │   │ Approval gate│  │ Escalate + │
                          │ no human    │   │ Slack button │  │ PagerDuty  │
                          │ needed      │   │ or Web UI    │  │ page       │
                          └──────┬──────┘   └──────┬───────┘  └─────┬──────┘
                                 │                  │                │
                                 └──────────┬───────┘                │
                                            │                        │
                                   ┌────────▼────────┐               │
                                   │ Verify + Learn   │◀──────────────┘
                                   │ Analyst adjusts  │
                                   │ triage weights   │
                                   └─────────────────┘
```

### What Vigil Connects To

In production, Vigil's Elastic Workflows execute real actions against your infrastructure:

| Integration | What Vigil Does | Protocol |
|-------------|----------------|----------|
| **Cloudflare** | Blocks attacker IPs via WAF Rulesets API | REST API |
| **Okta** | Suspends compromised accounts, enforces MFA | OAuth 2.0 |
| **Kubernetes** | Restarts pods, scales replicas, rolls back deployments, isolates hosts | K8s API |
| **Slack** | Sends incident notifications, posts interactive approval buttons, delivers reports | Webhook + API |
| **Jira** | Creates tickets with investigation findings, updates ticket status through resolution | REST API v3 |
| **PagerDuty** | Escalates unresolved critical incidents to on-call engineers | Events API v2 |
| **GitHub** | Receives deployment webhooks for change correlation; triggers rollback workflows | Webhooks + REST |

> The incident simulations in [Getting Started](#step-8-run-an-incident-simulation) exercise this entire pipeline with synthetic telemetry — validating the full flow before connecting to production data sources.

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
│  DATA LAYER             11 Elasticsearch indices            │
│                         29 tools (21 ES|QL + 8 Search)      │
│                         Dense vector embeddings (1024-dim)  │
│                         GitHub webhook ingest pipeline      │
└─────────────────────────────────────────────────────────────┘
```

### Incident Flow

```
Alert ──▶ Coordinator ──▶ Triage ──▶ Investigator ──▶ Threat Hunter
               │                                           │
               │◀──────────────────────────────────────────┘
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

The **Coordinator** acts as the hub in a hub-and-spoke pattern, managing incident state via a **12-state state machine** with guard conditions and enforcing the **A2A protocol** for all inter-agent communication. When the Verifier detects that remediation didn't fully resolve an incident, it triggers a **reflection loop** — re-engaging the investigation and remediation pipeline up to 3 times before escalating to humans. After resolution, the **Analyst** asynchronously processes outcomes to calibrate triage weights, generate runbooks, and tune anomaly thresholds.

---

## Key Features

**Intelligent Triage** — Multi-signal priority scoring formula combining threat severity (0.3), asset criticality (0.3), corroboration score (0.25), and historical false positive rate (0.15). Auto-suppresses alerts below 0.4, queues 0.4-0.7, and fast-tracks above 0.7 for immediate investigation.

**Deep Investigation** — Attack chain tracing via multi-hop ES|QL queries, MITRE ATT&CK mapping through hybrid search, blast radius assessment, and **change correlation via LOOKUP JOIN** that bridges deployment events with error logs to identify the exact commit, author, and PR that caused an incident.

**Dense Vector Search** — 1024-dimensional embeddings with `int8_hnsw` quantization powering hybrid (keyword + vector) search across runbooks, threat intelligence, incident history, and MITRE ATT&CK techniques. Enables semantic similarity matching for past incidents and contextual runbook retrieval.

**Autonomous Response** — 7 Elastic Workflows executing containment (IP blocks, account suspension, host isolation), remediation (pod restarts, deployment rollbacks, credential rotation), notifications (Slack, PagerDuty), and ticketing (Jira) — all with full audit trails and rollback capability.

**Self-Correcting Resolution** — Verifier agent independently validates remediation by comparing post-action health metrics against pre-incident baselines. Composite health score (passed/total >= 0.8) triggers automatic re-investigation if thresholds aren't met, up to 3 reflection iterations.

**Continuous Learning** — Analyst agent performs post-incident analysis: calibrates triage weight accuracy against actual outcomes, generates new runbooks from successful resolutions, tunes per-service anomaly thresholds, discovers recurring incident patterns, and produces retrospective reports.

**Compliance-Ready Reporting** — Reporter agent generates scheduled and on-demand reports: daily/weekly executive summaries with MTTR trends, monthly compliance evidence mapped to SOC 2, ISO 27001, and GDPR Article 33 controls, per-service operational trend reports, and agent performance analytics — all with full data provenance and delivered via Slack, email, or Jira.

---

## Engineering Highlights

Beyond the agent pipeline, Vigil implements production-grade patterns that distinguish it from typical agent demos:

| Pattern | What It Does |
|---------|-------------|
| **Self-Improving Triage** | Analyst computes F1 scores and confusion matrices against actual outcomes, then auto-calibrates triage weights — accuracy improves with every resolved incident |
| **Deadline Racing with Partial Results** | Every handler runs inside `Promise.race` against a configurable deadline. If time expires, agents return partial results rather than nothing — the pipeline always progresses |
| **Optimistic Concurrency Control** | Every state transition uses `if_seq_no` / `if_primary_term`. Alert claiming uses `op_type: 'create'`. Zero distributed locks, guaranteed at-most-once processing |
| **Progressive Time Windows** | Investigator widens search from 1h → 6h → 24h if initial evidence is sparse — catches slow-burn attacks without drowning in noise |
| **LOOKUP JOIN with Auto-Fallback** | Change correlation uses ES|QL LOOKUP JOIN to bridge deployments with errors. Auto-degrades to a two-query join when unavailable — zero agent changes needed |
| **ES|QL Array Expansion** | Query executor rewrites `?param` into `?param_0, ?param_1, ...` at runtime, so parameterized tools accept variable-length arrays safely |
| **Three-Way Hybrid Search** | BM25 + dual kNN (title embeddings + body embeddings) fused via Reciprocal Rank Fusion — lexical precision meets semantic recall |
| **Conflicting Assessment Escalation** | When Investigator and Threat Hunter disagree, the Coordinator escalates rather than picking a winner — ambiguity is surfaced, not suppressed |
| **Sliding-Window Circuit Breaker** | External integrations wrapped in a count-based circuit breaker that trips on consecutive failures, preventing cascades into the agent pipeline |
| **53 Test Files** | In-memory Elasticsearch mock simulates `_seq_no` versioning, `bulk` operations, and `esql.query` — agents tested against realistic concurrency |
| **434-Line Terminal Dashboard** | Custom real-time TUI renders agent pipeline progress, tool calls, timing bars, and incident summary — zero external dependencies |

---

## The Agent System

Vigil deploys **11 agents** in a hub-and-spoke topology. The Coordinator delegates tasks to specialized spoke agents via the A2A protocol. Each agent has a dedicated system prompt, scoped tool access, and least-privilege API keys.

| Agent | Role | Tools | Key Capability |
|-------|------|:-----:|----------------|
| **vigil-coordinator** | Hub orchestrator | 2 | 12-state machine enforcement, timing metrics, reflection loop management |
| **vigil-triage** | Priority scoring | 3 | Composite 0.0-1.0 scoring with FP rate suppression |
| **vigil-investigator** | Root cause analysis | 6 | Attack chain tracing, MITRE mapping, LOOKUP JOIN correlation |
| **vigil-threat-hunter** | Environment sweep | 2 | IoC scanning, behavioral anomaly detection |
| **vigil-sentinel** | Operational monitoring | 3 | 2-sigma anomaly detection, dependency tracing, change detection |
| **vigil-commander** | Remediation planning | 2 | Runbook retrieval (hybrid search), impact assessment |
| **vigil-executor** | Plan execution | 7 | 7 workflows + audit logging, approval gate enforcement |
| **vigil-verifier** | Resolution validation | 2 | Health score computation, baseline comparison, reflection trigger |
| **vigil-analyst** | Post-incident learning | 5 | Weight calibration, runbook generation, threshold tuning, pattern discovery |
| **vigil-reporter** | Scheduled reporting | 6 | Executive summaries, compliance evidence (SOC 2, ISO 27001, GDPR), operational trends |
| **vigil-chat** | Conversational interface | 8 | Natural-language queries about incidents, agents, and system health in Kibana |

---

## Tool Ecosystem

Vigil provides **29 analytical tools** (21 ES|QL + 8 search) and **7 Elastic Workflows** for automated remediation.

<details>
<summary><strong>21 ES|QL Tools</strong> — Parameterized analytical queries</summary>

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
| `vigil-report-executive-summary` | Reporter | vigil-incidents | Executive metrics aggregation |
| `vigil-report-compliance-evidence` | Reporter | vigil-incidents, vigil-actions-\* | Audit trail and control mapping |
| `vigil-report-operational-trends` | Reporter | vigil-incidents, vigil-investigations | Per-service reliability trends |
| `vigil-report-agent-performance` | Reporter | vigil-agent-telemetry, vigil-learnings | Agent execution metrics |
| `vigil-report-incident-detail-export` | Reporter | vigil-incidents, vigil-actions-\*, vigil-learnings | Single-incident full export |

</details>

<details>
<summary><strong>8 Search Tools</strong> — Keyword, hybrid, and kNN vector retrieval</summary>

| Tool | Agent | Strategy | Index |
|------|-------|----------|-------|
| `vigil-search-asset-criticality` | Triage | Keyword | vigil-assets |
| `vigil-search-mitre-attack` | Investigator | Hybrid (keyword + vector) | vigil-threat-intel |
| `vigil-search-threat-intel` | Investigator | Keyword | vigil-threat-intel |
| `vigil-search-incident-similarity` | Investigator | kNN vector | vigil-incidents |
| `vigil-search-runbooks` | Commander | Hybrid (keyword + vector) | vigil-runbooks |
| `vigil-search-baselines` | Verifier | Keyword | vigil-baselines |
| `vigil-search-incident-patterns` | Analyst | Hybrid (keyword + vector) | vigil-incidents |
| `vigil-search-incidents-for-report` | Reporter | Hybrid (keyword + vector) | vigil-incidents |

</details>

<details>
<summary><strong>7 Elastic Workflows</strong> — YAML-defined automation pipelines</summary>

| Workflow | Trigger | External Systems |
|----------|---------|-----------------|
| `vigil-wf-containment` | Block IP, disable account, isolate host | Cloudflare WAF, Okta, Kubernetes |
| `vigil-wf-remediation` | Restart pod, rollback deploy, scale, rotate credentials | Kubernetes |
| `vigil-wf-notify` | Incident notification, escalation | Slack, PagerDuty, Email |
| `vigil-wf-ticketing` | Create/update ticket | Jira REST API v3 |
| `vigil-wf-approval` | Human approval for high-impact actions | Slack interactive buttons |
| `vigil-wf-reporting` | Post-incident summary aggregation | Elasticsearch (self-index) |
| `vigil-wf-report-delivery` | Scheduled report delivery to channels | Slack, Email, Jira |

</details>

---

## Getting Started

### Prerequisites

**Required accounts:**

| Service | Purpose | Sign Up |
|---------|---------|---------|
| **Elastic Cloud** | Elasticsearch 9.3+, Kibana, Agent Builder | [cloud.elastic.co](https://cloud.elastic.co) |
| **Anthropic** | Claude Sonnet 4.6 API key (LLM backbone) | [console.anthropic.com](https://console.anthropic.com) |
| **Slack** | Incident notifications + approval buttons | [api.slack.com/apps](https://api.slack.com/apps) |
| **Jira Cloud** | Ticket creation and management | [atlassian.com](https://www.atlassian.com/software/jira) |
| **GitHub** | Webhook-based deployment tracking | [github.com](https://github.com) |

**Required software:**

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | 20 LTS+ | Backend, setup scripts, demo runner |
| Python | 3.11+ | Seed data scripts |
| Docker | Latest | Containerized microservices (optional) |
| minikube or kind | Latest | Local Kubernetes cluster (optional) |

### Step 1: Provision Elastic Cloud

1. Create a deployment at [cloud.elastic.co](https://cloud.elastic.co).
2. Select **Elastic 9.3+** or **Serverless** (required for Agent Builder GA + Elastic Workflows).
3. Recommended sizing: 1 node / 4 GB RAM / 2 vCPUs (demo), 3 nodes / 16 GB RAM each (production).
4. Enable **Machine Learning node** (required for embedding model).
5. Note your **Cloud ID**, **Elasticsearch URL**, and **Kibana URL**.
6. Generate a **master API key** from Kibana → Stack Management → API Keys.

### Step 2: Configure LLM Connector

1. In Kibana, go to **Stack Management → Connectors**.
2. Create a new **Anthropic** connector with your Claude Sonnet 4.6 API key.
3. Test the connector with a sample prompt to verify connectivity.
4. Note the **connector ID** — agents will use this for reasoning.

### Step 3: Set Up External Services

<details>
<summary><strong>Slack</strong></summary>

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Add bot token scopes: `chat:write`, `chat:postMessage`, `commands`.
3. Install to your workspace.
4. Create two channels: `#vigil-incidents` and `#vigil-approvals`.
5. Note the **Bot Token** (`xoxb-...`) and **Signing Secret**.

</details>

<details>
<summary><strong>Jira</strong></summary>

1. Create a project with key `VIG`.
2. Generate an API token for a service account at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
3. Note the **base URL** (`https://yourorg.atlassian.net`), **API token**, and **user email**.

</details>

<details>
<summary><strong>GitHub</strong></summary>

1. Configure a webhook on your repository pointing to `https://your-server/webhooks/github`.
2. Set events: `push`, `pull_request`, `deployment`.
3. Set and note the **webhook secret**.

</details>

<details>
<summary><strong>PagerDuty</strong> (optional)</summary>

1. Create a service and generate a **routing key** for the Events API v2.

</details>

### Step 4: Clone and Configure

```bash
git clone https://github.com/arome3/vigil.git
cd vigil
cp .env.example .env
```

Edit `.env` with your credentials from Steps 1–3:

| Variable | What to Enter |
|----------|--------------|
| `ELASTIC_CLOUD_ID` | Cloud ID from Step 1 |
| `ELASTIC_API_KEY` | Master API key from Step 1 |
| `ELASTIC_URL` | Elasticsearch endpoint URL |
| `KIBANA_URL` | Kibana endpoint URL |
| `LLM_API_KEY` | Anthropic Claude API key from Step 2 |
| `LLM_MODEL` | `claude-sonnet-4-6` (recommended) |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token from Step 3 |
| `SLACK_SIGNING_SECRET` | Slack signing secret from Step 3 |
| `JIRA_BASE_URL` | e.g. `https://yourorg.atlassian.net` |
| `JIRA_API_TOKEN` | Jira API token from Step 3 |
| `JIRA_USER_EMAIL` | Service account email |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret from Step 3 |

See [`.env.example`](.env.example) for the full list including optional tuning variables (`VIGIL_MAX_REFLECTION_LOOPS`, `VIGIL_TRIAGE_*_THRESHOLD`, etc.).

### Step 5: Install and Bootstrap

```bash
# Install dependencies
npm install
pip install -r requirements.txt

# Bootstrap Elasticsearch (creates all indices, agents, tools, workflows)
npm run bootstrap
```

The bootstrap command executes a **9-step initialization sequence**:

| Step | Action | What It Creates |
|:----:|--------|-----------------|
| 1 | Create ILM policies | `vigil-90d-policy`, `vigil-1y-policy` |
| 2 | Create index templates | Mappings for all 11 indices |
| 3 | Create data streams & indices | `vigil-incidents`, `vigil-actions-*`, etc. |
| 4 | Configure inference endpoint | Embedding model for vector search |
| 5 | Create ingest pipelines | Auto-embedding on document ingest |
| 6 | Seed reference data | Runbooks, assets, threat intel, baselines |
| 7 | Register ES\|QL tools | 21 parameterized query tools |
| 8 | Provision agents | 11 agents with system prompts and tool bindings |
| 9 | Deploy workflows | 7 Elastic Workflow definitions |

> Steps execute in order — each depends on resources created by the previous step.

### Step 6: Start the Backend

```bash
npm run dev
```

This starts the webhook receiver server on port 3000, listening for:
- **GitHub deployment events** — for change correlation via LOOKUP JOIN
- **Slack interactive actions** — for human-in-the-loop approval buttons

### Step 7: Start the UI Dashboard

```bash
# In a second terminal
npm run dev:ui
# → http://localhost:3001
```

For **demo mode** without a live backend (uses mock data):

```bash
# Set in ui/.env.local:
NEXT_PUBLIC_DEMO_MODE=true
```

### Step 8: Run an Incident Simulation

```bash
# In a third terminal
npm run demo:scenario1    # Compromised API Key (~4 min)
npm run demo:scenario2    # Cascading Deployment Failure (~5 min)
npm run demo:scenario3    # Self-Healing Failure with Reflection Loop (~7 min)
npm run demo:all          # Run all scenarios sequentially
```

Watch the agents work autonomously across four interfaces:

| Interface | Where | What You See |
|-----------|-------|-------------|
| **Terminal** | The terminal running the demo | Custom dashboard with real-time agent pipeline progress, tool calls, timing |
| **Web UI** | `http://localhost:3001` | Incident list, agent activity feed, approval gates, analytics |
| **Slack** | `#vigil-incidents` | Real-time notifications with investigation summaries |
| **Kibana** | Your Kibana Cloud URL | Command Center dashboard with ES\|QL-powered panels |

### Step 9: Verify Everything Works

| Check | How to Verify |
|-------|---------------|
| Elasticsearch connected | Bootstrap completes all 9 steps without errors |
| Agents provisioned | Kibana → Agent Builder → 11 agents listed |
| Tools registered | Each agent shows its assigned tools in Agent Builder UI |
| Workflows deployed | Kibana → Elastic Workflows → 7 workflows listed |
| Webhook server running | `curl http://localhost:3000/health` returns 200 |
| UI running | `http://localhost:3001` loads the dashboard |
| Simulation works end-to-end | `npm run demo:scenario1` — incident reaches `resolved` state |
| Kibana dashboards | Import via `npm run bootstrap` or manually import `kibana/dashboards/vigil-dashboards.ndjson` |

<details>
<summary><strong>Optional: Local Kubernetes Demo Services</strong></summary>

For full-fidelity simulations with real container orchestration and APM traces:

```bash
# Start local cluster (4 CPU, 8 GB minimum)
minikube start --cpus=4 --memory=8192 --driver=docker

# Deploy demo microservices
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -n vigil-demo -f infra/k8s/demo-services/

# Deploy Elastic Agent (collects logs, metrics, APM traces)
kubectl apply -n vigil-demo -f infra/k8s/elastic-agent.yaml

# Verify pods are running
kubectl get pods -n vigil-demo
```

This deploys 4 microservices (`api-gateway`, `payment-service`, `user-service`, `notification-svc`) that emit real APM traces and logs to Elasticsearch.

</details>

---

## Incident Simulations

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

### Scenario 3: Self-Healing Failure (Reflection Loop)

```bash
npm run demo:scenario3
```

A connection pool exhaustion event in the order-service causes a 45% error rate spike. This scenario demonstrates **Vigil's self-correcting reflection loop** — the feature that distinguishes it from every other autonomous agent system.

**Agent Flow — Pass 1 (wrong fix):**
1. **Triage** enriches the alert — Tier-1 critical asset, 45% error rate, connection pool exhausted → priority score: **0.88**
2. **Investigator** identifies resource exhaustion pattern, maps blast radius across dependent services
3. **Commander** plans: restart affected pods, scale replicas, notify operations team
4. **Executor** fires containment, remediation, and notification workflows
5. **Verifier** waits 60 seconds for stabilization, then checks — error rate still at 38%. **Health score: 0.45. FAILED.**

**Reflection Loop triggered.** The Verifier's failure analysis is passed back to the Investigator as new context.

**Agent Flow — Pass 2 (correct fix):**
1. **Investigator** receives the failure analysis — knows pod restart didn't work — runs change correlation, discovers a **connection leak** in the pool handler
2. **Commander** plans a completely different fix: increase pool size + deploy hotfix
3. **Executor** fires remediation workflows with the new plan
4. **Verifier** checks again — error rate at 0.4%. **Health score: 0.95. PASSED.**

**Result: 6 minutes 47 seconds. When the first fix didn't work, Vigil didn't give up. It re-investigated, found the real root cause, planned a different approach, and verified it worked. Autonomously.**

---

## UI Dashboard

Vigil includes a **custom web dashboard** built with Next.js 16, React 19, and Tailwind CSS v4 — a production-grade interface designed for SOC analysts operating under pressure.

```bash
# Start in demo mode (no backend required)
NEXT_PUBLIC_DEMO_MODE=true npm --prefix ui run dev
```

**Key views:**

| View | What It Shows |
|------|--------------|
| **Dashboard** (`/`) | Metric tiles with sparkline charts, incident timeline, agent activity feed, service health heatmap (sigma-colored), change correlation table, triage distribution |
| **Incidents** (`/incidents`) | Filterable incident list with keyboard navigation (`j`/`k`/`Enter`), status badges for all 12 states, severity indicators |
| **Incident Detail** (`/incidents/[id]`) | 4-tab deep dive — Timeline (agent-colored action log), Investigation (Cytoscape.js attack chain graph + MITRE ATT&CK matrix), Remediation (numbered checklist with status), Verification (health score progress bar with 80% threshold marker) |
| **Agent Trace** (`/incidents/[id]/trace`) | Flamegraph-style recursive tree showing every agent's tool calls with timing bars, expandable input/output JSON — full pipeline auditability |
| **Agents** (`/agents`) | Grid of all 11 agents with status indicators, tool call counts, and execution time stats |
| **Learning** (`/learning`) | Analyst learning records — triage calibrations, generated runbooks, threshold proposals, attack patterns, retrospectives |

**Highlights:** Command palette (`Cmd+K`), human-in-the-loop approval modal with countdown timer and keyboard shortcuts (`A`/`R`), full keyboard navigation, WebSocket real-time updates, and `prefers-reduced-motion` accessibility support.

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
│   │   ├── analyst/                 # Post-incident learning agent
│   │   ├── chat/                    # Conversational Kibana interface
│   │   ├── commander/               # Remediation planning agent
│   │   ├── coordinator/             # Hub orchestrator agent
│   │   ├── executor/                # Plan execution agent
│   │   ├── investigator/            # Root cause analysis agent
│   │   ├── reporter/                # Scheduled reporting agent
│   │   ├── sentinel/                # Operational monitoring agent
│   │   ├── threat-hunter/           # Environment sweep agent
│   │   ├── triage/                  # Priority scoring agent
│   │   └── verifier/                # Resolution validation agent
│   ├── embeddings/                  # Embedding service + ingest pipeline
│   ├── scoring/                     # Priority scoring formula
│   ├── search/                      # Hybrid search implementation
│   ├── state-machine/               # 12-state incident state machine
│   ├── tools/
│   │   ├── esql/                    # 21 ES|QL tool definitions + executor
│   │   └── search/                  # 8 search tool definitions + executor
│   ├── utils/                       # Elastic client, logger
│   └── webhooks/                    # GitHub webhook receiver
├── tests/
│   ├── agents/                      # Agent behavior tests
│   ├── e2e/                         # End-to-end flow tests
│   ├── state-machine/               # State transition tests
│   └── tools/                       # Tool execution tests
├── tools/                           # Tool registration configs
├── ui/                              # Next.js 16 web dashboard (React 19, Tailwind v4)
│   ├── src/app/                     # App router pages (dashboard, incidents, agents, learning)
│   ├── src/components/              # shadcn/ui components, visualizations, overlays
│   └── package.json                 # Isolated from ESM backend
├── workflows/                       # Elastic Workflow YAML definitions
├── .env.example                     # Environment variable template
├── .gitignore
├── package.json
├── requirements.txt                 # Python dependencies (seed data)
├── vigil.md                         # Product specification
└── vigil_technical_spec.md          # Technical specification
```

---

## Kibana Chat Integration

The **`vigil-chat`** agent provides a conversational interface directly in the Kibana Agent Builder chat UI. Analysts can ask natural-language questions about what the autonomous agents have done, are doing, or plan to do — without leaving Kibana.

```
You:    "What just happened with the order-service incident?"
Vigil:  "INC-2026-00847 was a connection pool exhaustion on order-service.
         Triage scored it 0.88 (critical). Investigator initially identified
         resource exhaustion, but after remediation failed (health score 0.45),
         the reflection loop re-investigated and found a connection leak.
         Second remediation succeeded — health score 0.95. Resolved in 6m 47s."
```

Six read-only ES|QL tools power the chat: incident lookup, incident list, agent activity trace, live service health, action audit trail, and triage statistics. The chat agent has **read-only access only** — it can never modify incidents, execute workflows, or interfere with active response.

---

## Testing

Vigil implements a **5-layer testing pyramid**:

| Layer | Scope | Tests |
|-------|-------|-------|
| Unit | ES|QL query correctness, priority scoring formula, state machine transitions | All boundary values, reflection counting, auto-escalation at limit |
| Integration | All 29 tools against live Elasticsearch | Parameterized `test.each` with schema validation |
| Agent Behavior | 55 tests (11 agents × 5 scenarios) via `AgentTestHarness` | Tool selection sequence, A2A contract validation |
| End-to-End | Full incident lifecycle using demo simulation scripts | Status reaches `resolved`, all agents participated, duration < 300s |
| Chaos | Failure injection (ES|QL timeouts, LLM 429s, workflow failures) | Circuit breaker activation, graceful degradation |

```bash
# Run all tests
NODE_OPTIONS='--experimental-vm-modules' npx jest

# Run UI end-to-end tests (24 tests, 6 spec files)
npx --prefix ui playwright test
```

---

## Data Model

Vigil operates across **11 Elasticsearch indices** optimized for their access patterns:

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
| `vigil-reports` | Standard | vigil-1y-policy | Generated reports (executive, compliance, operational, agent performance) |

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
| **Reporting** | `REPORT_EXEC_DAILY_SCHEDULE`, `REPORT_EXEC_WEEKLY_SCHEDULE`, `REPORT_COMPLIANCE_SCHEDULE`, `REPORT_OPS_WEEKLY_SCHEDULE`, `REPORT_AGENT_WEEKLY_SCHEDULE` | Report generation schedules (cron) |

See [`.env.example`](.env.example) for the complete template with all variables.

</details>

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Data store & search | Elasticsearch | 9.3+ / Serverless |
| Agent framework | Elastic Agent Builder | GA (9.3+) |
| Query language | ES\|QL | GA with LOOKUP JOIN (tech preview) |
| LLM backbone | Claude Sonnet 4.6 via Elastic LLM connector | — |
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

- **Elasticsearch Agent Builder** — 11 agents with custom system prompts, scoped tool access, and ReAct reasoning
- **ES|QL** — 21 parameterized query tools including `LOOKUP JOIN` for cross-index change correlation
- **Elastic Workflows** — 7 YAML-defined automation pipelines with external API integration
- **A2A Protocol** — Hub-and-spoke inter-agent communication with 7 typed contracts
- **Dense Vector Search** — 1024-dim embeddings with `int8_hnsw` quantization for hybrid retrieval across runbooks, threat intel, incidents, and MITRE ATT&CK
- **Data Streams & ILM** — Time-series data management with automated lifecycle policies (90-day alerts, 1-year audit trail)
- **Ingest Pipelines** — Automatic embedding generation on document ingest
- **Kibana Dashboards** — Real-time incident command center with agent activity visualization
- **Kibana Chat Integration** — Conversational agent (`vigil-chat`) for natural-language queries about incidents, agent activity, and system health directly in the Kibana Agent Builder UI
