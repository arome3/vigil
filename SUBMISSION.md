# Vigil — Autonomous Security Operations Center

## The Problem

Security Operations Centers face an unsustainable workload: analysts receive over 4,000 alerts daily, each requiring roughly 25 minutes of manual investigation, while more than 95% turn out to be false positives. The handoff between security investigation and operational remediation adds another 15–45 minutes of context-switching per incident. The result is analyst burnout, missed threats, and a mean time to resolution measured in hours — not minutes. Vigil eliminates this gap entirely.

## What Vigil Does

Vigil is an autonomous SOC platform that deploys 11 specialized AI agents — Coordinator, Triage, Investigator, Threat Hunter, Sentinel, Commander, Executor, Verifier, Analyst, Reporter, and Chat — orchestrated in a hub-and-spoke topology over the A2A protocol. From the moment an alert fires to full resolution, Vigil detects in under 30 seconds, investigates in under 60 seconds, and remediates in under 3 minutes. Incidents that previously consumed hours of human effort are resolved autonomously, with a human-in-the-loop approval gate for high-impact actions.

## Elastic Features Used

Vigil is built entirely on Elasticsearch and Agent Builder. Each agent is defined through Kibana Agent Builder with scoped tool access and dedicated system prompts. The platform uses **29 tools** — **21 parameterized ES|QL tools** for analytical reasoning (attack chain tracing, MITRE ATT&CK mapping, change correlation via LOOKUP JOIN that bridges deployment events from GitHub with error spikes to pinpoint the exact commit that caused an outage) and **8 Search tools** spanning keyword, hybrid (BM25 + kNN with RRF), and pure vector retrieval across runbooks, threat intelligence, incident history, and asset inventories, all powered by 1024-dimensional embeddings through Elastic's inference endpoint. **7 Elastic Workflows** handle actuation — blocking IPs through Cloudflare, suspending accounts via Okta, rolling back Kubernetes deployments, sending Slack notifications with interactive approval buttons, and creating Jira tickets — all with immutable audit logging.

## What I Liked and Found Challenging

I loved how **ES|QL parameterized queries** made it possible to build safe, injection-proof analytical tools that agents could call with dynamic inputs from untrusted alert data. The composability felt natural.

**Hybrid search with RRF** was a highlight — combining lexical precision with semantic recall for runbook retrieval meant the Commander agent could find relevant remediation procedures even when the terminology didn't match exactly.

The biggest challenge was **designing the reflection loop**. When the Verifier detects that health metrics haven't recovered post-remediation, the Coordinator re-enters an investigating state for up to 3 cycles before escalating. Getting the state machine transitions, concurrency control with `_seq_no`, and deadline budgets right across all 11 agents required careful orchestration — but it's what makes Vigil truly autonomous rather than just automated.

An unexpected highlight was the **self-improving triage system**. After every resolved incident, the Analyst agent computes F1 scores and confusion matrices comparing triage predictions against actual outcomes, then auto-calibrates the priority scoring weights. Over time, Vigil literally gets smarter — fewer false positives slip through, and genuine threats are prioritized faster. Building the feedback loop between resolution outcomes and triage accuracy felt like closing the final gap between "automated" and "autonomous."
