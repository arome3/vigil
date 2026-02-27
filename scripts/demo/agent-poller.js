// Real-time bridge between ES telemetry indices and the dashboard.
//
// Exports:
//   startPolling(incidentId, dashboard) — Start polling for agent activity
//   stopPolling()                       — Stop polling

import client from '../../src/utils/elastic-client.js';

let pollingInterval = null;
let lastPollTime = new Date().toISOString();

/**
 * Start polling ES for agent telemetry and incident state changes.
 *
 * @param {string} incidentId — The incident ID to track
 * @param {import('./dashboard.js').Dashboard} dashboard — Dashboard instance to update
 */
export function startPolling(incidentId, dashboard) {
  lastPollTime = new Date().toISOString();

  pollingInterval = setInterval(async () => {
    try {
      // 1. Poll agent telemetry for new tool executions
      const telemetry = await client.search({
        index: 'vigil-agent-telemetry',
        query: {
          bool: {
            filter: [
              { term: { incident_id: incidentId } },
              { range: { '@timestamp': { gt: lastPollTime } } }
            ]
          }
        },
        sort: [{ '@timestamp': 'asc' }],
        size: 50
      });

      for (const hit of telemetry.hits.hits) {
        const doc = hit._source;
        const agentName = (doc.agent_name || '').replace('vigil-', '');
        dashboard.addActivity(agentName || 'system', formatTelemetryEvent(doc));
        if (agentName && agentName !== 'coordinator') {
          dashboard.setAgentState(agentName, 'active');
        }
      }

      if (telemetry.hits.hits.length > 0) {
        lastPollTime = telemetry.hits.hits.at(-1)._source['@timestamp'];
      }

      // 2. Poll incident document for state changes
      const incident = await client.search({
        index: 'vigil-incidents',
        query: { term: { incident_id: incidentId } },
        size: 1
      });

      if (incident.hits.hits.length > 0) {
        const inc = incident.hits.hits[0]._source;
        updatePipelineFromIncidentState(inc, dashboard);

        // Check for terminal states
        if (inc.status === 'resolved' || inc.status === 'escalated') {
          dashboard.showResult(buildSummaryFromIncident(inc));
          dashboard.stop();
          stopPolling();
        }
      }
    } catch {
      // Silently continue — cluster may be processing
    }
  }, 2000);
}

/**
 * Stop the polling interval.
 */
export function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Map a telemetry document to a human-readable display string.
 */
function formatTelemetryEvent(doc) {
  switch (doc.action_type) {
    case 'tool_execution':
      return `Tool: ${doc.tool_name}`;
    case 'state_transition':
      return `State: ${doc.previous_state} \u2192 ${doc.new_state}`;
    case 'finding':
      return doc.result_summary || 'Finding detected';
    case 'delegation':
      return `Delegating to ${doc.target_agent || 'next agent'}`;
    case 'workflow_execution':
      return `Workflow: ${doc.workflow_id || doc.workflow_name}`;
    case 'verification_check':
      return doc.result_summary || 'Verification check';
    case 'reflection_trigger':
      return doc.result_summary || 'Reflection loop triggered';
    default:
      return doc.action_type || 'Activity';
  }
}

/**
 * Map incident status to active agent and update pipeline states.
 */
function updatePipelineFromIncidentState(incident, dashboard) {
  const stateToAgent = {
    triaging: 'triage',
    triaged: 'triage',
    investigating: 'investigator',
    threat_hunting: 'threat-hunter',
    planning: 'commander',
    awaiting_approval: 'commander',
    executing: 'executor',
    verifying: 'verifier',
    reflecting: 'verifier'
  };

  const activeAgent = stateToAgent[incident.status];
  if (!activeAgent) return;

  const pipeline = dashboard.pipeline;
  const activeIdx = pipeline.indexOf(activeAgent);
  if (activeIdx === -1) return;

  // Mark all agents before the active one as complete
  for (let i = 0; i < pipeline.length; i++) {
    if (i < activeIdx) {
      dashboard.setAgentState(pipeline[i], 'complete');
    } else if (i === activeIdx) {
      dashboard.setAgentState(
        pipeline[i],
        incident.status === 'reflecting' ? 'reflecting' : 'active'
      );
    }
  }
}

/**
 * Extract a summary object from an incident document for the dashboard result card.
 */
function buildSummaryFromIncident(incident) {
  return {
    incident_id: incident.incident_id,
    type: incident.incident_type,
    severity: incident.severity,
    priority: incident.triage?.priority_score,
    agents: incident.agents_involved,
    root_cause: incident.investigation?.root_cause_summary,
    mitre: incident.investigation?.mitre_mapping,
    actions: incident.remediation_plan?.actions,
    health_score: incident.verification_results?.at(-1)?.health_score,
    reflection_count: incident.reflection_count || 0,
    timing: incident.timing_metrics,
    total_duration: incident.total_duration_seconds,
    resolution_type: incident.resolution_type
  };
}
