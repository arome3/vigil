#!/usr/bin/env python3
"""Seed reference data into Elasticsearch for the Vigil platform."""

import hashlib
import os
import random
import sys

from dotenv import load_dotenv
from elasticsearch import Elasticsearch, helpers

load_dotenv()

ELASTIC_URL = os.getenv("ELASTIC_URL")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
ELASTIC_CLOUD_ID = os.getenv("ELASTIC_CLOUD_ID")

if not ELASTIC_API_KEY:
    print("ERROR: ELASTIC_API_KEY is required")
    sys.exit(1)

client_kwargs = {"api_key": ELASTIC_API_KEY}
if ELASTIC_URL:
    client_kwargs["hosts"] = [ELASTIC_URL]
elif ELASTIC_CLOUD_ID:
    client_kwargs["cloud_id"] = ELASTIC_CLOUD_ID
else:
    print("ERROR: ELASTIC_URL or ELASTIC_CLOUD_ID is required")
    sys.exit(1)

es = Elasticsearch(**client_kwargs)


def pseudo_vector(text, dims=1024):
    """Generate a deterministic pseudo-vector from text content."""
    seed = int(hashlib.sha256(text.encode()).hexdigest(), 16) % (2**32)
    rng = random.Random(seed)
    vec = [rng.gauss(0, 0.1) for _ in range(dims)]
    norm = sum(v * v for v in vec) ** 0.5
    return [v / norm for v in vec]


# ──────────────────────────────────────────────────
# Runbooks
# ──────────────────────────────────────────────────
RUNBOOKS = [
    {
        "_id": "runbook-credential-rotation",
        "runbook_id": "runbook-credential-rotation",
        "title": "Credential Rotation for Compromised Service Accounts",
        "description": "Step-by-step procedure for rotating compromised API keys, service account credentials, and access tokens. Includes pre-rotation validation, rolling rotation to avoid downtime, and post-rotation verification.",
        "content": "When a service account credential is confirmed compromised: (1) Identify all systems using the credential, (2) Generate new credentials in the secrets manager, (3) Update dependent services using rolling deployment, (4) Revoke the old credential, (5) Verify all services authenticate successfully with new credentials, (6) Monitor for unauthorized access attempts using old credentials.",
        "incident_types": ["credential_compromise", "api_key_exposure", "token_theft"],
        "applicable_services": ["payment-service", "user-service", "api-gateway", "notification-svc"],
        "severity_levels": ["critical", "high"],
        "steps": [
            {"order": 1, "action": "Identify all systems and services using the compromised credential", "command": "vigil-esql-blast-radius", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
            {"order": 2, "action": "Generate new credentials in the secrets manager", "command": "secrets-manager rotate-secret --secret-id {{secret_id}}", "target_system": "secrets-manager", "approval_required": False, "rollback_command": "secrets-manager restore-secret --secret-id {{secret_id}} --version previous"},
            {"order": 3, "action": "Update dependent services with new credentials via rolling deployment", "command": "kubectl rollout restart deployment/{{deployment_name}} -n vigil-demo", "target_system": "kubernetes", "approval_required": False, "rollback_command": "kubectl rollout undo deployment/{{deployment_name}} -n vigil-demo"},
            {"order": 4, "action": "Revoke the compromised credential", "command": "secrets-manager revoke-secret --secret-id {{secret_id}} --version compromised", "target_system": "secrets-manager", "approval_required": True, "rollback_command": "secrets-manager restore-secret --secret-id {{secret_id}} --version compromised"},
            {"order": 5, "action": "Verify all services authenticate successfully with new credentials", "command": "vigil-esql-health-comparison", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
        ],
        "historical_success_rate": 0.94,
        "times_used": 12,
        "last_used_at": "2026-02-10T14:22:00.000Z",
        "tags": ["credential", "rotation", "api-key", "service-account", "secrets-manager"],
    },
    {
        "_id": "runbook-deployment-rollback",
        "runbook_id": "runbook-deployment-rollback",
        "title": "Deployment Rollback for Failed or Degrading Releases",
        "description": "Procedure for rolling back a Kubernetes deployment when a release causes service degradation. Includes targeted rollback to a specific revision, replica scaling during rollback, and health verification.",
        "content": "When a deployment is identified as causing service degradation: (1) Confirm the deployment correlation via change analysis, (2) Scale up healthy replicas to handle traffic during rollback, (3) Initiate rollback to the last known good revision, (4) Monitor service health metrics during rollback, (5) Scale replicas back to normal once health is confirmed, (6) Create a Jira ticket for the deploying team with root cause analysis.",
        "incident_types": ["deployment_failure", "service_degradation", "error_spike"],
        "applicable_services": ["api-gateway", "payment-service", "user-service", "notification-svc"],
        "severity_levels": ["critical", "high", "medium"],
        "steps": [
            {"order": 1, "action": "Confirm deployment correlation via LOOKUP JOIN change analysis", "command": "vigil-esql-change-correlation", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
            {"order": 2, "action": "Scale up healthy replicas to handle traffic during rollback", "command": "kubectl scale deployment/{{deployment_name}} --replicas={{current_replicas + 2}} -n vigil-demo", "target_system": "kubernetes", "approval_required": False, "rollback_command": "kubectl scale deployment/{{deployment_name}} --replicas={{current_replicas}} -n vigil-demo"},
            {"order": 3, "action": "Rollback deployment to the revision before the bad commit", "command": "kubectl rollout undo deployment/{{deployment_name}} -n vigil-demo", "target_system": "kubernetes", "approval_required": True, "rollback_command": "kubectl rollout undo deployment/{{deployment_name}} -n vigil-demo"},
            {"order": 4, "action": "Monitor service health metrics for 60 seconds post-rollback", "command": "vigil-esql-health-monitor", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
            {"order": 5, "action": "Scale replicas back to normal count", "command": "kubectl scale deployment/{{deployment_name}} --replicas={{current_replicas}} -n vigil-demo", "target_system": "kubernetes", "approval_required": False, "rollback_command": None},
        ],
        "historical_success_rate": 0.91,
        "times_used": 8,
        "last_used_at": "2026-02-12T09:15:00.000Z",
        "tags": ["deployment", "rollback", "kubernetes", "service-degradation", "change-correlation"],
    },
    {
        "_id": "runbook-ip-block",
        "runbook_id": "runbook-ip-block",
        "title": "Malicious IP Blocking via WAF",
        "description": "Procedure for blocking malicious IP addresses or ranges through the Cloudflare WAF Rulesets API. Includes pre-block verification, rule creation, and post-block monitoring.",
        "content": "When malicious IPs are identified during investigation: (1) Verify the IPs are not internal or partner addresses, (2) Check for existing block rules to avoid duplicates, (3) Create a WAF block rule for the IP range, (4) Monitor for continued malicious traffic from alternate sources, (5) Log the block action for compliance audit.",
        "incident_types": ["brute_force", "credential_compromise", "data_exfiltration", "ddos"],
        "applicable_services": ["api-gateway", "payment-service", "user-service"],
        "severity_levels": ["critical", "high", "medium"],
        "steps": [
            {"order": 1, "action": "Verify target IPs are not internal or trusted partner addresses", "command": "vigil-search-asset-criticality", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
            {"order": 2, "action": "Create WAF block rule for the malicious IP range", "command": "cloudflare-waf create-rule --expression 'ip.src in { {{ip_range}} }' --action block", "target_system": "cloudflare-waf", "approval_required": False, "rollback_command": "cloudflare-waf delete-rule --rule-id {{rule_id}}"},
            {"order": 3, "action": "Monitor for continued malicious traffic from alternate source IPs", "command": "vigil-esql-ioc-sweep", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
        ],
        "historical_success_rate": 0.87,
        "times_used": 15,
        "last_used_at": "2026-02-15T16:45:00.000Z",
        "tags": ["ip-block", "waf", "firewall", "cloudflare", "containment"],
    },
    {
        "_id": "runbook-pod-restart",
        "runbook_id": "runbook-pod-restart",
        "title": "Pod Restart for Unhealthy Services",
        "description": "Procedure for restarting Kubernetes pods when a service is in a degraded state due to memory leaks, stuck processes, or corrupted state. Includes pre-restart health snapshot, rolling restart, and post-restart verification.",
        "content": "When a service is in a degraded state without a clear deployment correlation: (1) Capture current health metrics as pre-restart snapshot, (2) Verify sufficient replica count for rolling restart without downtime, (3) Execute rolling restart, (4) Wait for all pods to reach Ready state, (5) Verify health metrics return to baseline.",
        "incident_types": ["service_degradation", "resource_exhaustion", "memory_leak", "pod_crash_loop"],
        "applicable_services": ["api-gateway", "payment-service", "user-service", "notification-svc"],
        "severity_levels": ["high", "medium", "low"],
        "steps": [
            {"order": 1, "action": "Capture current health metrics as pre-restart baseline", "command": "vigil-esql-health-monitor", "target_system": "elasticsearch", "approval_required": False, "rollback_command": None},
            {"order": 2, "action": "Verify sufficient replica count (minimum 2 for zero-downtime restart)", "command": "kubectl get deployment/{{deployment_name}} -n vigil-demo -o jsonpath='{.spec.replicas}'", "target_system": "kubernetes", "approval_required": False, "rollback_command": None},
            {"order": 3, "action": "Execute rolling restart of the deployment", "command": "kubectl rollout restart deployment/{{deployment_name}} -n vigil-demo", "target_system": "kubernetes", "approval_required": False, "rollback_command": "kubectl rollout undo deployment/{{deployment_name}} -n vigil-demo"},
            {"order": 4, "action": "Wait for all pods to reach Ready state", "command": "kubectl rollout status deployment/{{deployment_name}} -n vigil-demo --timeout=120s", "target_system": "kubernetes", "approval_required": False, "rollback_command": None},
        ],
        "historical_success_rate": 0.96,
        "times_used": 23,
        "last_used_at": "2026-02-16T11:30:00.000Z",
        "tags": ["pod-restart", "kubernetes", "rolling-restart", "service-recovery"],
    },
    {
        "_id": "runbook-account-disable",
        "runbook_id": "runbook-account-disable",
        "title": "Compromised Account Suspension via Okta",
        "description": "Procedure for suspending a compromised user account through the Okta User Lifecycle API. Includes session termination, account suspension, and notification to the account owner's manager.",
        "content": "When a user account is confirmed compromised: (1) Terminate all active sessions to immediately revoke access, (2) Suspend the account via the identity provider, (3) Revoke any API tokens or OAuth grants associated with the account, (4) Notify the account owner's manager and the security team, (5) Create a ticket for account recovery after investigation completes.",
        "incident_types": ["credential_compromise", "account_takeover", "insider_threat"],
        "applicable_services": ["user-service", "api-gateway"],
        "severity_levels": ["critical", "high"],
        "steps": [
            {"order": 1, "action": "Terminate all active sessions for the compromised user", "command": "okta delete-sessions --user-id {{user_id}}", "target_system": "okta", "approval_required": False, "rollback_command": None},
            {"order": 2, "action": "Suspend the user account in Okta", "command": "okta suspend-user --user-id {{user_id}}", "target_system": "okta", "approval_required": True, "rollback_command": "okta unsuspend-user --user-id {{user_id}}"},
            {"order": 3, "action": "Revoke all OAuth grants and API tokens for the user", "command": "okta revoke-grants --user-id {{user_id}}", "target_system": "okta", "approval_required": False, "rollback_command": None},
            {"order": 4, "action": "Notify account owner manager and security team via Slack", "command": "slack post-message --channel #vigil-incidents --text 'Account {{username}} suspended due to compromise'", "target_system": "slack", "approval_required": False, "rollback_command": None},
        ],
        "historical_success_rate": 0.98,
        "times_used": 6,
        "last_used_at": "2026-02-08T08:00:00.000Z",
        "tags": ["account-disable", "okta", "suspension", "credential-compromise", "identity"],
    },
]

# ──────────────────────────────────────────────────
# Assets
# ──────────────────────────────────────────────────
ASSETS = [
    {
        "_id": "srv-api-gateway",
        "asset_id": "srv-api-gateway",
        "name": "api-gateway",
        "type": "microservice",
        "criticality": "tier-2",
        "environment": "production",
        "owner_team": "platform-team",
        "owner_email": "platform-team@example.com",
        "data_classification": "internal",
        "compliance_tags": [],
        "service_dependencies": ["payment-service", "user-service", "notification-svc"],
        "k8s_namespace": "vigil-demo",
        "k8s_deployment": "api-gateway",
        "github_repo": "vigil-demo/api-gateway",
        "ip_addresses": ["10.0.1.10"],
        "last_updated": "2026-02-17T00:00:00.000Z",
    },
    {
        "_id": "srv-payment-01",
        "asset_id": "srv-payment-01",
        "name": "payment-service",
        "type": "microservice",
        "criticality": "tier-1",
        "environment": "production",
        "owner_team": "payments-team",
        "owner_email": "payments-team@example.com",
        "data_classification": "pci-dss",
        "compliance_tags": ["pci-dss", "sox"],
        "service_dependencies": ["user-service", "notification-svc"],
        "k8s_namespace": "vigil-demo",
        "k8s_deployment": "payment-service",
        "github_repo": "vigil-demo/payment-service",
        "ip_addresses": ["10.0.1.20"],
        "last_updated": "2026-02-17T00:00:00.000Z",
    },
    {
        "_id": "srv-user-01",
        "asset_id": "srv-user-01",
        "name": "user-service",
        "type": "microservice",
        "criticality": "tier-1",
        "environment": "production",
        "owner_team": "auth-team",
        "owner_email": "auth-team@example.com",
        "data_classification": "gdpr",
        "compliance_tags": ["gdpr", "hipaa"],
        "service_dependencies": ["notification-svc"],
        "k8s_namespace": "vigil-demo",
        "k8s_deployment": "user-service",
        "github_repo": "vigil-demo/user-service",
        "ip_addresses": ["10.0.1.30"],
        "last_updated": "2026-02-17T00:00:00.000Z",
    },
    {
        "_id": "srv-notification-01",
        "asset_id": "srv-notification-01",
        "name": "notification-svc",
        "type": "microservice",
        "criticality": "tier-3",
        "environment": "production",
        "owner_team": "platform-team",
        "owner_email": "platform-team@example.com",
        "data_classification": "internal",
        "compliance_tags": [],
        "service_dependencies": [],
        "k8s_namespace": "vigil-demo",
        "k8s_deployment": "notification-svc",
        "github_repo": "vigil-demo/notification-svc",
        "ip_addresses": ["10.0.1.40"],
        "last_updated": "2026-02-17T00:00:00.000Z",
    },
]

# ──────────────────────────────────────────────────
# Threat Intelligence
# ──────────────────────────────────────────────────
THREAT_INTEL = [
    {
        "_id": "ioc-ip-001",
        "ioc_id": "ioc-ip-001",
        "type": "ip",
        "value": "203.0.113.42",
        "threat_actor": "APT-UNKNOWN-42",
        "confidence": 0.92,
        "source": "alienvault-otx",
        "first_seen": "2026-01-15T00:00:00.000Z",
        "last_seen": "2026-02-16T00:00:00.000Z",
        "mitre_technique_id": "T1071",
        "mitre_technique_name": "Application Layer Protocol",
        "mitre_tactic": "command-and-control",
        "description": "IP address associated with command-and-control infrastructure used by APT-UNKNOWN-42 for data exfiltration over HTTPS.",
        "tags": ["c2", "exfiltration", "apt"],
    },
    {
        "_id": "ioc-ip-002",
        "ioc_id": "ioc-ip-002",
        "type": "ip",
        "value": "198.51.100.10",
        "threat_actor": "APT-UNKNOWN-42",
        "confidence": 0.88,
        "source": "virustotal",
        "first_seen": "2026-01-20T00:00:00.000Z",
        "last_seen": "2026-02-14T00:00:00.000Z",
        "mitre_technique_id": "T1041",
        "mitre_technique_name": "Exfiltration Over C2 Channel",
        "mitre_tactic": "exfiltration",
        "description": "Secondary C2 server used for large-volume data exfiltration. Observed receiving bulk API responses from compromised payment services.",
        "tags": ["c2", "exfiltration", "data-theft"],
    },
    {
        "_id": "ioc-domain-001",
        "ioc_id": "ioc-domain-001",
        "type": "domain",
        "value": "malicious-c2.example.com",
        "threat_actor": "APT-UNKNOWN-42",
        "confidence": 0.95,
        "source": "misp",
        "first_seen": "2026-01-10T00:00:00.000Z",
        "last_seen": "2026-02-16T00:00:00.000Z",
        "mitre_technique_id": "T1071.001",
        "mitre_technique_name": "Web Protocols",
        "mitre_tactic": "command-and-control",
        "description": "Domain used for C2 communication via HTTPS. Resolves to rotating infrastructure across multiple cloud providers.",
        "tags": ["c2", "domain", "https"],
    },
    {
        "_id": "ioc-hash-001",
        "ioc_id": "ioc-hash-001",
        "type": "hash",
        "value": "a3f8c21bdef4e9087c4a1f2b3d5e6a7890abcdef1234567890abcdef12345678",
        "threat_actor": "APT-UNKNOWN-42",
        "confidence": 0.90,
        "source": "virustotal",
        "first_seen": "2026-02-01T00:00:00.000Z",
        "last_seen": "2026-02-15T00:00:00.000Z",
        "mitre_technique_id": "T1059.001",
        "mitre_technique_name": "PowerShell",
        "mitre_tactic": "execution",
        "description": "PowerShell script used for credential harvesting. Extracts API keys and tokens from environment variables and configuration files.",
        "tags": ["malware", "powershell", "credential-harvesting"],
    },
    {
        "_id": "mitre-T1552",
        "ioc_id": "mitre-T1552",
        "type": "mitre_technique",
        "value": "T1552",
        "threat_actor": None,
        "confidence": 1.0,
        "source": "mitre-attack",
        "first_seen": None,
        "last_seen": None,
        "mitre_technique_id": "T1552",
        "mitre_technique_name": "Unsecured Credentials",
        "mitre_tactic": "credential-access",
        "description": "Adversaries may search compromised systems to find and obtain insecurely stored credentials. These credentials can be stored and/or misplaced in many locations on a system, including plaintext files, environment variables, source code repositories, or internal documentation.",
        "tags": ["credential-access", "initial-compromise"],
    },
    {
        "_id": "mitre-T1041",
        "ioc_id": "mitre-T1041",
        "type": "mitre_technique",
        "value": "T1041",
        "threat_actor": None,
        "confidence": 1.0,
        "source": "mitre-attack",
        "first_seen": None,
        "last_seen": None,
        "mitre_technique_id": "T1041",
        "mitre_technique_name": "Exfiltration Over C2 Channel",
        "mitre_tactic": "exfiltration",
        "description": "Adversaries may steal data by exfiltrating it over an existing command and control channel. Stolen data is encoded into the normal communications channel using the same protocol as C2 communications.",
        "tags": ["exfiltration", "c2", "data-theft"],
    },
    {
        "_id": "mitre-T1078",
        "ioc_id": "mitre-T1078",
        "type": "mitre_technique",
        "value": "T1078",
        "threat_actor": None,
        "confidence": 1.0,
        "source": "mitre-attack",
        "first_seen": None,
        "last_seen": None,
        "mitre_technique_id": "T1078",
        "mitre_technique_name": "Valid Accounts",
        "mitre_tactic": "defense-evasion",
        "description": "Adversaries may obtain and abuse credentials of existing accounts as a means of gaining Initial Access, Persistence, Privilege Escalation, or Defense Evasion. Compromised credentials may be used to bypass access controls placed on various resources on systems within the network.",
        "tags": ["defense-evasion", "persistence", "initial-access", "privilege-escalation"],
    },
    {
        "_id": "mitre-T1110",
        "ioc_id": "mitre-T1110",
        "type": "mitre_technique",
        "value": "T1110",
        "threat_actor": None,
        "confidence": 1.0,
        "source": "mitre-attack",
        "first_seen": None,
        "last_seen": None,
        "mitre_technique_id": "T1110",
        "mitre_technique_name": "Brute Force",
        "mitre_tactic": "credential-access",
        "description": "Adversaries may use brute force techniques to gain access to accounts when passwords are unknown or when password hashes are obtained. Techniques include password spraying, credential stuffing, and systematic password guessing.",
        "tags": ["credential-access", "brute-force", "password-spraying"],
    },
]

# ──────────────────────────────────────────────────
# Baselines (4 services x 5 metrics = 20 records)
# ──────────────────────────────────────────────────
BASELINE_DATA = {
    "api-gateway": {
        "latency":    {"avg": 45000.0, "stddev": 8500.0, "p50": 42000.0, "p95": 78000.0, "p99": 120000.0, "min": 12000.0, "max": 250000.0, "samples": 1250000},
        "error_rate": {"avg": 0.12, "stddev": 0.08, "p50": 0.10, "p95": 0.25, "p99": 0.45, "min": 0.01, "max": 0.85, "samples": 1250000},
        "throughput": {"avg": 850.0, "stddev": 120.0, "p50": 820.0, "p95": 1100.0, "p99": 1350.0, "min": 200.0, "max": 1800.0, "samples": 10080},
        "cpu":        {"avg": 35.0, "stddev": 12.0, "p50": 32.0, "p95": 58.0, "p99": 72.0, "min": 8.0, "max": 85.0, "samples": 10080},
        "memory":     {"avg": 62.0, "stddev": 8.0, "p50": 60.0, "p95": 78.0, "p99": 85.0, "min": 45.0, "max": 92.0, "samples": 10080},
    },
    "payment-service": {
        "latency":    {"avg": 120000.0, "stddev": 25000.0, "p50": 105000.0, "p95": 180000.0, "p99": 350000.0, "min": 35000.0, "max": 500000.0, "samples": 850000},
        "error_rate": {"avg": 0.08, "stddev": 0.05, "p50": 0.06, "p95": 0.18, "p99": 0.30, "min": 0.01, "max": 0.55, "samples": 850000},
        "throughput": {"avg": 580.0, "stddev": 95.0, "p50": 560.0, "p95": 780.0, "p99": 920.0, "min": 150.0, "max": 1200.0, "samples": 10080},
        "cpu":        {"avg": 42.0, "stddev": 14.0, "p50": 40.0, "p95": 65.0, "p99": 78.0, "min": 10.0, "max": 90.0, "samples": 10080},
        "memory":     {"avg": 68.0, "stddev": 10.0, "p50": 65.0, "p95": 85.0, "p99": 92.0, "min": 50.0, "max": 95.0, "samples": 10080},
    },
    "user-service": {
        "latency":    {"avg": 65000.0, "stddev": 15000.0, "p50": 58000.0, "p95": 95000.0, "p99": 150000.0, "min": 18000.0, "max": 280000.0, "samples": 950000},
        "error_rate": {"avg": 0.15, "stddev": 0.10, "p50": 0.12, "p95": 0.35, "p99": 0.52, "min": 0.02, "max": 0.80, "samples": 950000},
        "throughput": {"avg": 720.0, "stddev": 110.0, "p50": 700.0, "p95": 950.0, "p99": 1100.0, "min": 180.0, "max": 1500.0, "samples": 10080},
        "cpu":        {"avg": 38.0, "stddev": 11.0, "p50": 36.0, "p95": 55.0, "p99": 68.0, "min": 9.0, "max": 82.0, "samples": 10080},
        "memory":     {"avg": 55.0, "stddev": 9.0, "p50": 53.0, "p95": 72.0, "p99": 80.0, "min": 38.0, "max": 88.0, "samples": 10080},
    },
    "notification-svc": {
        "latency":    {"avg": 30000.0, "stddev": 6000.0, "p50": 28000.0, "p95": 45000.0, "p99": 65000.0, "min": 8000.0, "max": 120000.0, "samples": 600000},
        "error_rate": {"avg": 0.05, "stddev": 0.03, "p50": 0.04, "p95": 0.10, "p99": 0.18, "min": 0.00, "max": 0.35, "samples": 600000},
        "throughput": {"avg": 450.0, "stddev": 75.0, "p50": 430.0, "p95": 600.0, "p99": 720.0, "min": 100.0, "max": 950.0, "samples": 10080},
        "cpu":        {"avg": 22.0, "stddev": 8.0, "p50": 20.0, "p95": 38.0, "p99": 48.0, "min": 5.0, "max": 60.0, "samples": 10080},
        "memory":     {"avg": 48.0, "stddev": 7.0, "p50": 46.0, "p95": 62.0, "p99": 70.0, "min": 32.0, "max": 78.0, "samples": 10080},
    },
}

BASELINES = []
for svc, metrics in BASELINE_DATA.items():
    for metric_name, vals in metrics.items():
        doc_id = f"baseline-{svc}-{metric_name}"
        BASELINES.append({
            "_id": doc_id,
            "service_name": svc,
            "metric_name": metric_name,
            "window_start": "2026-02-10T00:00:00.000Z",
            "window_end": "2026-02-17T00:00:00.000Z",
            "avg_value": vals["avg"],
            "stddev_value": vals["stddev"],
            "p50_value": vals["p50"],
            "p95_value": vals["p95"],
            "p99_value": vals["p99"],
            "min_value": vals["min"],
            "max_value": vals["max"],
            "sample_count": vals["samples"],
            "computed_at": "2026-02-17T06:00:00.000Z",
        })


def add_vectors(docs, text_field, vector_field):
    """Add pseudo-vector embeddings to documents that have a text field."""
    for doc in docs:
        text = doc.get(text_field)
        if text:
            doc[vector_field] = pseudo_vector(text)


def bulk_index(index, docs):
    """Bulk index documents with explicit _id for idempotency."""
    actions = []
    for doc in docs:
        doc_copy = dict(doc)
        doc_id = doc_copy.pop("_id")
        actions.append({
            "_index": index,
            "_id": doc_id,
            "_source": doc_copy,
        })
    success, errors = helpers.bulk(es, actions, raise_on_error=False)
    return success, errors


def main():
    # Add vector embeddings
    add_vectors(RUNBOOKS, "content", "content_vector")
    add_vectors(THREAT_INTEL, "description", "description_vector")

    datasets = [
        ("vigil-runbooks", RUNBOOKS),
        ("vigil-assets", ASSETS),
        ("vigil-threat-intel", THREAT_INTEL),
        ("vigil-baselines", BASELINES),
    ]

    for index, docs in datasets:
        success, errors = bulk_index(index, docs)
        if errors:
            print(f"WARNING: {index} — {len(errors) if isinstance(errors, list) else errors} errors during indexing")
        print(f"OK: {index} — {success} documents indexed")

    # Verify counts
    print("\n--- Verification ---")
    for index, docs in datasets:
        count = es.count(index=index)["count"]
        expected = len(docs)
        status = "PASS" if count >= expected else "FAIL"
        print(f"{status}: {index} — {count} documents (expected >= {expected})")


if __name__ == "__main__":
    main()
