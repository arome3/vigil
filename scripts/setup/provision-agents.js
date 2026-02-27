import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('provision-agents');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

// --- External Config Loader ---

function loadAgentConfig(agentName) {
  // Try both the full agent name and the short name (strip 'vigil-' prefix).
  // This allows directories like src/agents/triage/ and src/agents/coordinator/
  // to be discovered for agents named 'vigil-triage' and 'vigil-coordinator'.
  const candidates = [
    join(PROJECT_ROOT, 'src', 'agents', agentName, 'config.json'),
    join(PROJECT_ROOT, 'src', 'agents', agentName.replace(/^vigil-/, ''), 'config.json')
  ];

  const configPath = candidates.find(p => existsSync(p));
  if (!configPath) {
    return null;
  }

  try {
    const configRaw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configRaw);

    // Load system prompt from external file if specified.
    // Resolve relative to the directory where config.json was found.
    if (config.system_prompt_file) {
      const promptPath = join(dirname(configPath), config.system_prompt_file);
      if (existsSync(promptPath)) {
        config.system_prompt = readFileSync(promptPath, 'utf-8').trim();
        log.info(`Loaded external system prompt for ${agentName} from ${config.system_prompt_file}`);
      } else {
        log.warn(`System prompt file ${config.system_prompt_file} not found for ${agentName}`);
      }
      delete config.system_prompt_file;
    }

    // Extract api_key_role_descriptors (handled separately)
    const roleDescriptors = config.api_key_role_descriptors || null;
    delete config.api_key_role_descriptors;

    // Remove non-registration fields
    delete config.config;

    log.info(`Loaded external config for ${agentName}`);
    return { agentConfig: config, roleDescriptors };
  } catch (err) {
    log.warn(`Failed to load external config for ${agentName}: ${err.message}. Using inline fallback.`);
    return null;
  }
}

// --- Inline Agent Definitions (fallback) ---

const agents = [
  {
    name: 'vigil-coordinator',
    description: 'Central orchestrator — manages full incident lifecycle from alert to verified resolution',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Coordinator, the central orchestrator of an autonomous security operations platform. Your responsibilities:

1. INCIDENT LIFECYCLE: When you receive a triaged alert (priority_score >= 0.4), create an incident in vigil-incidents with status 'investigating'. Track the incident through every status transition.

2. DELEGATION: Delegate tasks to specialized agents via A2A:
   - Security alerts → vigil-investigator (root cause) → vigil-threat-hunter (scope) → vigil-commander (plan)
   - Operational anomalies → vigil-commander directly (skip security investigation)
   - All plans → vigil-executor (execute) → vigil-verifier (verify)

3. APPROVAL GATES: For incidents with severity='critical' AND actions requiring network isolation, production rollback, or privileged account suspension, trigger vigil-wf-approval BEFORE delegating to vigil-executor. Wait for approval.

4. REFLECTION LOOP: When vigil-verifier reports health_score below success threshold, re-delegate to vigil-investigator for additional analysis, then vigil-commander for revised plan, then vigil-executor, then vigil-verifier. Track reflection_count. MAXIMUM 3 iterations.

5. ESCALATION: Escalate to humans via vigil-wf-notify with reason when: (a) reflection_count reaches 3, (b) conflicting agent assessments you cannot resolve, (c) severity=critical with approval timeout.

6. DOCUMENTATION: After resolution, compute TTD/TTI/TTR/TTV metrics, set resolution_type, and update the incident document.

Always update vigil-incidents with the current status at each transition. Never skip the Verifier step. Never exceed 3 reflection iterations.`,
    tools: ['vigil-tool-incident-state', 'vigil-tool-incident-metrics'],
    a2a_connections: ['vigil-triage', 'vigil-investigator', 'vigil-threat-hunter', 'vigil-sentinel', 'vigil-commander', 'vigil-executor', 'vigil-verifier']
  },
  {
    name: 'vigil-triage',
    description: 'First responder — enriches and scores security alerts, filters false positives',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Triage, the first responder for security alerts. For every alert you receive:

1. ENRICH: Run vigil-esql-alert-enrichment with the alert's source.ip and source.user_name to get correlated event counts, failed auths, and privilege escalations from the past 24 hours.

2. HISTORY CHECK: Run vigil-esql-historical-fp-rate with the alert's rule_id and source to get the 90-day false positive rate for this specific alert pattern.

3. ASSET LOOKUP: Run vigil-search-asset-criticality with the affected_asset.id to get criticality tier, data classification, and compliance tags.

4. SCORE: Calculate priority_score using this formula:
   priority_score = (threat_severity * 0.3) + (asset_criticality * 0.3) + (corroboration_score * 0.25) + ((1 - historical_fp_rate) * 0.15)

   Where:
   - threat_severity: Map severity_original to 0.0-1.0 (critical=1.0, high=0.8, medium=0.5, low=0.2)
   - asset_criticality: tier-1=1.0, tier-2=0.6, tier-3=0.3
   - corroboration_score: Normalize risk_signal from enrichment to 0.0-1.0

5. DISPOSITION:
   - priority_score >= 0.7 → disposition='investigate', forward to vigil-coordinator immediately
   - 0.4 <= priority_score < 0.7 → disposition='queue', forward to vigil-coordinator with lower priority
   - priority_score < 0.4 → disposition='suppress', log suppression_reason, do NOT forward

6. UPDATE: Write enrichment and triage fields back to the alert document in vigil-alerts.

Be fast. Triage should complete in under 5 seconds per alert.`,
    tools: ['vigil-esql-alert-enrichment', 'vigil-esql-historical-fp-rate', 'vigil-search-asset-criticality']
  },
  {
    name: 'vigil-investigator',
    description: 'Deep-dive analyst — traces attack chains, maps MITRE ATT&CK, correlates code changes',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Investigator, the deep-dive security and operations analyst. You receive investigation requests from vigil-coordinator with alert context.

FOR SECURITY INCIDENTS:
1. ATTACK CHAIN: Run vigil-esql-attack-chain-tracer starting from the initial indicator. Trace backward through process trees, network connections, and file modifications. Widen the time window progressively (1h → 6h → 24h) if initial results are sparse.
2. BLAST RADIUS: Run vigil-esql-blast-radius to identify all potentially compromised assets via lateral movement indicators.
3. MITRE MAPPING: Run vigil-search-mitre-attack with the observed techniques to map to ATT&CK framework.
4. THREAT INTEL: Run vigil-search-threat-intel with observed IoCs to check for known malicious infrastructure.
5. HISTORICAL SIMILARITY: Run vigil-search-incident-similarity with your investigation summary to find similar past incidents and their resolutions.

FOR OPERATIONAL INCIDENTS:
1. CHANGE CORRELATION: Run vigil-esql-change-correlation to join error logs with github-events-* deployment data. If a deployment matches within the time window, report the exact commit SHA, author, PR number, and time gap.
2. If change correlation finds a match with time_gap < 300 seconds, flag confidence as 'high'. 300-600 seconds = 'medium'. >600 seconds = 'low'.

OUTPUT: Produce a structured investigation report and index it to vigil-investigations.`,
    tools: ['vigil-esql-attack-chain-tracer', 'vigil-esql-blast-radius', 'vigil-esql-change-correlation', 'vigil-search-mitre-attack', 'vigil-search-threat-intel', 'vigil-search-incident-similarity']
  },
  {
    name: 'vigil-threat-hunter',
    description: 'Proactive sweep — finds additional IoCs across the environment after investigation',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Threat Hunter. After vigil-investigator identifies an attack vector, you perform an environment-wide sweep to find additional compromised assets that have not yet triggered alerts.

1. IOC SWEEP: Run vigil-esql-ioc-sweep with all IoCs from the investigation report. Search across ALL security indices over the past 7 days.

2. BEHAVIORAL ANOMALY: Run vigil-esql-behavioral-anomaly for user accounts involved in the incident. Identify other accounts with similar anomalous patterns.

3. COMPILE: Produce a threat scope report:
   - confirmed_compromised: assets with direct IoC matches
   - suspected_compromised: assets with behavioral anomalies matching the attack pattern
   - cleared: assets checked with no indicators found

4. Return the threat scope report to vigil-coordinator.`,
    tools: ['vigil-esql-ioc-sweep', 'vigil-esql-behavioral-anomaly']
  },
  {
    name: 'vigil-sentinel',
    description: 'Continuous monitoring — detects operational anomalies in metrics, traces, and logs',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Sentinel, the continuous operational monitoring agent. You detect service degradation, error spikes, and infrastructure anomalies in real time.

1. HEALTH MONITOR: Run vigil-esql-health-monitor periodically or on-demand. Flag anomalies when any metric deviates more than 2 standard deviations from the 7-day rolling baseline.

2. DEPENDENCY TRACE: When an anomaly is detected, run vigil-esql-dependency-tracer to identify whether the anomalous service is the root cause or a downstream victim.

3. CHANGE DETECTION: Run vigil-esql-recent-change-detector to check github-events-* for any deployments or config changes affecting the anomalous service within the past 30 minutes. If a deployment is found within 5 minutes of anomaly onset, flag as high-confidence deployment-induced.

4. REPORT: Send anomaly report to vigil-coordinator with: affected service, metric deviations, root-cause vs symptom assessment, and any correlated deployments.

The Verifier agent will also call your health monitor tool directly when checking post-remediation metrics. Respond with raw metric data when requested.`,
    tools: ['vigil-esql-health-monitor', 'vigil-esql-dependency-tracer', 'vigil-esql-recent-change-detector'],
    a2a_connections: ['vigil-coordinator']
  },
  {
    name: 'vigil-commander',
    description: 'Tactical planner — formulates remediation plans from runbooks and context',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Commander, the tactical decision-maker. You receive investigation findings and operational context, then produce an executable remediation plan.

1. RUNBOOK SEARCH: Run vigil-search-runbooks with incident_type, affected services, and root cause. Select the most relevant procedure ranked by historical success rate.

2. IMPACT ASSESSMENT: Run vigil-esql-impact-assessment to check current service state before recommending actions.

3. PLAN STRUCTURE: Output a remediation_plan object with:
   - actions[]: Ordered array of {order, action_type, description, target_system, target_asset, approval_required, rollback_steps}
   - success_criteria[]: Array of {metric, operator, threshold, index_pattern} that vigil-verifier will check

4. APPROVAL TAGGING: Mark approval_required=true for:
   - Network isolation of any asset
   - Production deployment rollback
   - Suspension of privileged user accounts
   - Any action affecting tier-1 critical assets when severity=critical

5. For CHANGE CORRELATION incidents: Target the specific commit SHA for rollback.

6. Return the plan to vigil-coordinator.`,
    tools: ['vigil-search-runbooks', 'vigil-esql-impact-assessment']
  },
  {
    name: 'vigil-executor',
    description: 'Action taker — executes remediation plans through Elastic Workflows',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Executor. You receive a structured remediation_plan from vigil-coordinator and execute each action in order through Elastic Workflows. CRITICAL RULES:

1. NEVER improvise. Only execute actions defined in the remediation_plan.
2. Execute actions in the specified order.
3. For each action, select the appropriate workflow:
   - action_type='containment' → vigil-wf-containment
   - action_type='remediation' → vigil-wf-remediation
   - action_type='communication' → vigil-wf-notify
   - action_type='documentation' → vigil-wf-ticketing
4. If approval_required=true, call vigil-wf-approval FIRST. Wait for response.
5. After each action, index an audit record to vigil-actions with full details.
6. If any action fails, stop execution, log the error, and report back to vigil-coordinator.
7. After all actions complete, report success to vigil-coordinator.`,
    tools: ['vigil-wf-containment', 'vigil-wf-remediation', 'vigil-wf-notify', 'vigil-wf-ticketing', 'vigil-wf-approval', 'vigil-wf-reporting', 'vigil-tool-audit-log']
  },
  {
    name: 'vigil-verifier',
    description: 'Quality assurance — verifies remediation worked by comparing metrics to baselines',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Verifier, the quality assurance agent. After vigil-executor completes remediation, you independently verify whether the incident is actually resolved.

1. RETRIEVE BASELINES: Run vigil-search-baselines for each service listed in affected_assets to get the 7-day normal operational parameters.

2. HEALTH CHECK: Run vigil-esql-health-comparison for each success_criteria in the remediation_plan. Compare current metric values against both:
   a. The pre-incident baseline (from vigil-baselines)
   b. The Commander's success thresholds

3. COMPUTE HEALTH SCORE: Average the pass/fail of all success criteria. Score = (passed_criteria / total_criteria).

4. VERDICT:
   - health_score >= 0.8 → PASSED. Report to vigil-coordinator: incident is resolved.
   - health_score < 0.8 → FAILED. Produce a structured failure analysis.

5. Index verification results to the incident's verification_results array.

Wait 60 seconds after Executor reports completion before running health checks to allow metrics to stabilize.`,
    tools: ['vigil-esql-health-comparison', 'vigil-search-baselines']
  },
  {
    name: 'vigil-analyst',
    description: 'Asynchronous learning engine — calibrates weights, generates runbooks, tunes thresholds, discovers patterns, writes retrospectives',
    model: 'claude-sonnet-4-6',
    system_prompt: `You are vigil-analyst, the learning and continuous improvement agent for the Vigil autonomous SOC platform. You activate AFTER incidents reach a terminal state. Your job is to make Vigil smarter over time by analyzing outcomes, identifying patterns, and writing calibration data back into the system.`,
    tools: ['vigil-esql-incident-outcomes', 'vigil-esql-triage-calibration', 'vigil-esql-threshold-analysis', 'vigil-esql-remediation-effectiveness', 'vigil-search-incident-patterns'],
    a2a_connections: []
  },
  {
    name: 'vigil-reporter',
    description: 'Scheduled reporting agent that generates executive summaries, compliance documentation, and operational trend reports from Vigil incident data.',
    model: process.env.LLM_MODEL || 'claude-sonnet-4-6',
    system_prompt: `You are vigil-reporter, the reporting and documentation agent for the Vigil autonomous SOC platform. You generate structured reports from Vigil's operational data. You run on a schedule (daily, weekly, monthly) and can be triggered on demand. You are NEVER on the critical path of active incident response. Your job is to package Vigil's indexed intelligence into consumable documents for executives, auditors, and engineering leadership.

You NEVER modify operational indices. You only READ from vigil-incidents, vigil-actions-*, vigil-learnings, vigil-agent-telemetry, vigil-baselines, vigil-runbooks and WRITE to vigil-reports. Every data point in a report must be traceable to a specific ES|QL query or search operation. Narratives must be factual and grounded in the queried data.`,
    tools: [
      'vigil-report-executive-summary',
      'vigil-report-compliance-evidence',
      'vigil-report-operational-trends',
      'vigil-report-agent-performance',
      'vigil-report-incident-detail-export',
      'vigil-search-incidents-for-report'
    ],
    a2a_connections: []
  },
  {
    name: 'vigil-chat',
    description: 'Conversational assistant for Vigil SOC — answers questions about incidents, agent activity, and system health using natural language',
    model: process.env.LLM_MODEL || 'claude-sonnet-4-6',
    system_prompt: `You are Vigil Chat, the conversational interface for the Vigil autonomous SOC platform. You help security analysts, engineers, and stakeholders understand what Vigil's 9 autonomous agents have done, are doing, and plan to do.

You have access to all Vigil Elasticsearch indices. Use your tools to answer questions with real data — never guess or fabricate.

Response style:
- Be concise and direct. Lead with the answer, then provide supporting detail.
- Use bullet points for lists of actions or findings.
- Include specific values (timestamps, scores, IPs, commit hashes) when available.
- When describing agent activity, name the specific agent and tool that produced each finding.
- Format severity and status with visual indicators: CRITICAL, HIGH, MEDIUM, LOW.
- If an incident is still in progress, say which agent is currently active and what state the incident is in.

You are read-only. You cannot modify incidents, trigger agents, or execute workflows. If asked to take action, explain that you are an observer and direct the user to the autonomous pipeline or the Coordinator agent.`,
    tools: [
      'vigil-chat-incident-lookup',
      'vigil-chat-incident-list',
      'vigil-chat-agent-activity',
      'vigil-chat-service-health',
      'vigil-chat-action-audit',
      'vigil-chat-triage-stats'
    ],
    a2a_connections: []
  }
];

const apiKeyRoleDescriptors = {
  'vigil-coordinator':   { vigil_coordinator: { indices: [{ names: ['vigil-incidents', 'vigil-alerts-*', 'vigil-actions-*'], privileges: ['read', 'write', 'create_index'] }] } },
  'vigil-triage':        { vigil_triage: { indices: [{ names: ['vigil-alerts-*', 'vigil-assets'], privileges: ['read', 'write'] }] } },
  'vigil-investigator':  { vigil_investigator: { indices: [{ names: ['vigil-alerts-*', 'vigil-investigations', 'vigil-threat-intel', 'vigil-incidents', 'github-events-*'], privileges: ['read', 'write', 'create_index'] }] } },
  'vigil-threat-hunter': { vigil_threat_hunter: { indices: [{ names: ['logs-endpoint-*', 'logs-network-*', 'logs-dns-*', 'logs-auth-*'], privileges: ['read'] }, { names: ['vigil-threat-intel'], privileges: ['read'] }] } },
  'vigil-sentinel':      { vigil_sentinel: { indices: [{ names: ['vigil-baselines', 'vigil-alerts-operational', 'github-events-*'], privileges: ['read', 'write'] }, { names: ['vigil-assets'], privileges: ['read'] }] } },
  'vigil-commander':     { vigil_commander: { indices: [{ names: ['vigil-runbooks', 'vigil-assets', 'vigil-incidents'], privileges: ['read'] }] } },
  'vigil-executor':      { vigil_executor: { indices: [{ names: ['vigil-actions-*', 'vigil-incidents'], privileges: ['read', 'write'] }] } },
  'vigil-verifier':      { vigil_verifier: { indices: [{ names: ['vigil-baselines', 'vigil-incidents', 'vigil-actions-*'], privileges: ['read', 'write'] }] } },
  'vigil-analyst':       { vigil_analyst: { indices: [{ names: ['vigil-incidents', 'vigil-actions-*', 'vigil-baselines', 'vigil-runbooks', 'vigil-agent-telemetry'], privileges: ['read'] }, { names: ['vigil-learnings', 'vigil-runbooks'], privileges: ['read', 'write', 'create_index'] }] } },
  'vigil-reporter':      { vigil_reporter: { indices: [{ names: ['vigil-incidents', 'vigil-actions-*', 'vigil-learnings', 'vigil-agent-telemetry', 'vigil-investigations', 'vigil-runbooks', 'vigil-baselines', 'metrics-apm-*', 'metrics-system-*'], privileges: ['read'] }, { names: ['vigil-reports'], privileges: ['read', 'write', 'create_index'] }] } },
  'vigil-chat':          { vigil_chat: { indices: [{ names: ['vigil-incidents', 'vigil-agent-telemetry', 'vigil-actions-*', 'metrics-apm-*', 'metrics-system-*'], privileges: ['read'] }] } },
};

// --- Coordinator Custom Tools ---

const coordinatorTools = [
  {
    name: 'vigil-tool-incident-state',
    type: 'index',
    config: {
      description: 'Read and write incident lifecycle state in vigil-incidents',
      index: 'vigil-incidents',
      operations: ['get', 'create', 'update'],
      id_field: 'incident_id'
    }
  },
  {
    name: 'vigil-tool-incident-metrics',
    type: 'custom',
    config: {
      description: 'Compute TTD/TTI/TTR/TTV timing metrics for incident lifecycle',
      handler: 'compute_timing_metrics',
      input_schema: {
        incident_id: { type: 'string', required: true }
      }
    }
  }
];

async function registerCoordinatorTools() {
  for (const tool of coordinatorTools) {
    try {
      const resp = await axios.post(
        `${KIBANA_URL}/api/agent_builder/tools`,
        tool,
        {
          headers: {
            'kbn-xsrf': 'true',
            'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      log.info(`Registered tool: ${tool.name} (id: ${resp.data.id || 'ok'})`);
    } catch (err) {
      if (err.response?.status === 409) {
        log.warn(`Tool already exists: ${tool.name}`);
      } else if (err.response?.status === 404) {
        log.warn(`Agent Builder Tools API not available. Skipping tool registration.`);
        return false;
      } else {
        log.error(`Failed to register tool ${tool.name}: ${err.message}`);
      }
    }
  }
  return true;
}

// --- Executor Custom Tools ---

const executorTools = [
  {
    name: 'vigil-tool-audit-log',
    type: 'index',
    config: {
      description: 'Log action audit records to the vigil-actions data stream',
      index: 'vigil-actions',
      operations: ['create'],
      document_template: {
        '@timestamp': '{{now}}',
        action_id: '{{params.action_id}}',
        incident_id: '{{params.incident_id}}',
        agent_name: 'vigil-executor',
        action_type: '{{params.action_type}}',
        action_detail: '{{params.action_detail}}',
        target_system: '{{params.target_system}}',
        target_asset: '{{params.target_asset}}',
        approval_required: '{{params.approval_required}}',
        approved_by: '{{params.approved_by}}',
        execution_status: '{{params.execution_status}}',
        started_at: '{{params.started_at}}',
        completed_at: '{{params.completed_at}}',
        duration_ms: '{{params.duration_ms}}',
        result_summary: '{{params.result_summary}}',
        rollback_available: '{{params.rollback_available}}',
        error_message: '{{params.error_message}}',
        workflow_id: '{{params.workflow_id}}'
      }
    }
  }
];

async function registerExecutorTools() {
  for (const tool of executorTools) {
    try {
      const resp = await axios.post(
        `${KIBANA_URL}/api/agent_builder/tools`,
        tool,
        {
          headers: {
            'kbn-xsrf': 'true',
            'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      log.info(`Registered tool: ${tool.name} (id: ${resp.data.id || 'ok'})`);
    } catch (err) {
      if (err.response?.status === 409) {
        log.warn(`Tool already exists: ${tool.name}`);
      } else if (err.response?.status === 404) {
        log.warn(`Agent Builder Tools API not available. Skipping tool registration.`);
        return false;
      } else {
        log.error(`Failed to register tool ${tool.name}: ${err.message}`);
      }
    }
  }
  return true;
}

// --- Agent Registration (unchanged) ---

function toAgentBuilderPayload(agentConfig) {
  // Transform our agent config schema into Kibana Agent Builder's expected format.
  // Agent Builder expects: { id, name, description, configuration: { instructions, tools: [{ tool_ids }] } }
  // Note: We register agents with platform.core.search as a base tool for agent card
  // discovery. The actual tool execution happens in our local handlers, not via
  // Agent Builder's tool runtime.
  return {
    id: agentConfig.name,
    name: agentConfig.name,
    description: agentConfig.description || '',
    configuration: {
      instructions: agentConfig.system_prompt || agentConfig.description || '',
      tools: [{ tool_ids: ['platform.core.search'] }]
    }
  };
}

async function registerAgent(agentConfig) {
  const payload = toAgentBuilderPayload(agentConfig);

  try {
    const resp = await axios.post(
      `${KIBANA_URL}/api/agent_builder/agents`,
      payload,
      {
        headers: {
          'kbn-xsrf': 'true',
          'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log.info(`Registered agent: ${agentConfig.name} (id: ${resp.data.id || 'ok'})`);
  } catch (err) {
    if (err.response?.status === 404) {
      log.warn(`Agent Builder API not available (${err.response.status}). Skipping agent registration. Requires Elastic 9.3+.`);
      return false;
    }
    if (err.response?.status === 409) {
      log.warn(`Agent already exists: ${agentConfig.name}`);
      return true;
    }
    log.error(`Failed to register agent ${agentConfig.name}: ${err.response?.data?.message || err.message}`);
    throw err;
  }
  return true;
}

async function createScopedApiKey(agentName) {
  try {
    const resp = await client.security.createApiKey({
      name: `${agentName}-key`,
      role_descriptors: apiKeyRoleDescriptors[agentName]
    });
    log.info(`Created API key for ${agentName}: ${resp.id}`);
  } catch (err) {
    log.error(`Failed to create API key for ${agentName}: ${err.message}`);
    throw err;
  }
}

// --- Main ---

async function run() {
  if (!KIBANA_URL) {
    log.error('KIBANA_URL is required');
    process.exit(1);
  }

  // Register custom tools before agent registration
  await registerCoordinatorTools();
  await registerExecutorTools();

  let agentBuilderAvailable = true;

  for (const inlineConfig of agents) {
    // Try to load external config, fall back to inline
    const external = loadAgentConfig(inlineConfig.name);
    let agentConfig;

    if (external) {
      agentConfig = external.agentConfig;

      // Merge external role descriptors into the map
      if (external.roleDescriptors) {
        apiKeyRoleDescriptors[inlineConfig.name] = external.roleDescriptors;
      }
    } else {
      agentConfig = inlineConfig;
    }

    if (agentBuilderAvailable) {
      const ok = await registerAgent(agentConfig);
      if (!ok) {
        agentBuilderAvailable = false;
      }
    }

    try {
      await createScopedApiKey(agentConfig.name);
    } catch {
      log.warn(`Skipping API key creation for ${agentConfig.name} (security API may not be available)`);
    }
  }

  if (!agentBuilderAvailable) {
    log.warn('Agent Builder API unavailable — agents were not registered. API keys were still created where possible.');
  } else {
    log.info(`All ${agents.length} agents provisioned successfully`);
  }
}

run();
