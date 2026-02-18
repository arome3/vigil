import 'dotenv/config';
import axios from 'axios';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('deploy-workflows');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

const workflows = [
  {
    name: 'vigil-wf-containment',
    description: 'Execute containment actions (block IP, disable account, isolate host, revoke key)',
    triggers: [{ type: 'api', enabled: true }],
    params: {
      incident_id:   { type: 'string', required: true },
      action_type:   { type: 'string', required: true },
      target_value:  { type: 'string', required: true },
      target_system: { type: 'string', required: true }
    },
    steps: [
      {
        id: 'execute_containment',
        type: 'webhook',
        config: {
          url: '{{resolve_url(params.action_type, params.target_system)}}',
          method: 'POST',
          headers: {
            Authorization: "Bearer {{secrets[params.target_system + '_token']}}",
            'Content-Type': 'application/json'
          },
          body: '{{resolve_body(params.action_type, params.target_value)}}'
        },
        on_failure: 'notify_failure'
      },
      {
        id: 'log_action',
        type: 'index',
        config: {
          index: 'vigil-actions',
          document: {
            '@timestamp': '{{now}}',
            action_id: '{{generate_id()}}',
            incident_id: '{{params.incident_id}}',
            agent_name: 'vigil-executor',
            action_type: 'containment',
            action_detail: '{{params.action_type}} on {{params.target_value}}',
            target_system: '{{params.target_system}}',
            execution_status: 'completed',
            started_at: '{{step.execute_containment.started_at}}',
            completed_at: '{{now}}',
            rollback_available: true
          }
        }
      },
      {
        id: 'notify_failure',
        type: 'webhook',
        condition: "{{step.execute_containment.status == 'failed'}}",
        config: {
          url: '{{secrets.slack_webhook}}',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            text: 'Containment FAILED for {{params.incident_id}}: {{params.action_type}} on {{params.target_value}}. Error: {{step.execute_containment.error}}'
          }
        }
      }
    ]
  },
  {
    name: 'vigil-wf-remediation',
    description: 'Execute remediation actions (restart, rollback, scale, rotate credentials)',
    triggers: [{ type: 'api', enabled: true }],
    params: {
      incident_id:    { type: 'string', required: true },
      action_type:    { type: 'string', required: true },
      target_service: { type: 'string', required: true },
      target_params:  { type: 'object', required: false }
    },
    steps: [
      {
        id: 'pre_health_check',
        type: 'esql',
        config: {
          query: "FROM metrics-apm-* | WHERE @timestamp > NOW() - 2m AND service.name == \"{{params.target_service}}\" | STATS request_count = COUNT(*), error_rate = SUM(CASE(event.outcome == \"failure\", 1, 0)) / COUNT(*) * 100 | KEEP request_count, error_rate"
        }
      },
      {
        id: 'execute_remediation',
        type: 'webhook',
        config: {
          url: '{{resolve_remediation_url(params.action_type, params.target_service)}}',
          method: 'POST',
          headers: {
            Authorization: "Bearer {{secrets[resolve_system(params.action_type) + '_token']}}",
            'Content-Type': 'application/json'
          },
          body: '{{resolve_remediation_body(params)}}',
          timeout: '120s',
          retry: { max_attempts: 2, backoff: 'exponential' }
        },
        on_failure: 'log_failure'
      },
      {
        id: 'log_action',
        type: 'index',
        config: {
          index: 'vigil-actions',
          document: {
            '@timestamp': '{{now}}',
            action_id: '{{generate_id()}}',
            incident_id: '{{params.incident_id}}',
            agent_name: 'vigil-executor',
            action_type: 'remediation',
            action_detail: '{{params.action_type}} on {{params.target_service}}',
            target_system: '{{resolve_system(params.action_type)}}',
            target_asset: '{{params.target_service}}',
            execution_status: 'completed',
            started_at: '{{step.execute_remediation.started_at}}',
            completed_at: '{{now}}',
            duration_ms: '{{step.execute_remediation.duration_ms}}',
            rollback_available: true
          }
        }
      },
      {
        id: 'log_failure',
        type: 'index',
        condition: "{{step.execute_remediation.status == 'failed'}}",
        config: {
          index: 'vigil-actions',
          document: {
            '@timestamp': '{{now}}',
            action_id: '{{generate_id()}}',
            incident_id: '{{params.incident_id}}',
            agent_name: 'vigil-executor',
            action_type: 'remediation',
            action_detail: '{{params.action_type}} on {{params.target_service}}',
            execution_status: 'failed',
            error_message: '{{step.execute_remediation.error}}'
          }
        }
      }
    ]
  },
  {
    name: 'vigil-wf-notify',
    description: 'Send notifications to Slack, PagerDuty, or email',
    triggers: [{ type: 'api', enabled: true }],
    params: {
      incident_id: { type: 'string', required: true },
      severity:    { type: 'string', required: true },
      channel:     { type: 'string', required: true },
      message:     { type: 'string', required: true },
      details:     { type: 'object', required: false }
    },
    steps: [
      {
        id: 'route_slack',
        type: 'webhook',
        condition: "{{params.channel == 'slack'}}",
        config: {
          url: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          headers: {
            Authorization: 'Bearer {{secrets.slack_bot_token}}',
            'Content-Type': 'application/json'
          },
          body: {
            channel: '{{secrets.slack_incident_channel}}',
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: 'Vigil Incident: {{params.incident_id}}' } },
              { type: 'section', text: { type: 'mrkdwn', text: '*Severity:* {{params.severity}} | *Time:* {{now}}' } },
              { type: 'divider' },
              { type: 'section', text: { type: 'mrkdwn', text: '{{params.message}}' } },
              { type: 'section', fields: [
                { type: 'mrkdwn', text: '*Affected Services:*\n{{params.details.affected_services}}' },
                { type: 'mrkdwn', text: '*Root Cause:*\n{{params.details.root_cause}}' }
              ]},
              { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent by Vigil Autonomous SOC | <{{secrets.kibana_url}}/app/vigil/incident/{{params.incident_id}}|View in Kibana>' }] }
            ]
          }
        }
      },
      {
        id: 'route_pagerduty',
        type: 'webhook',
        condition: "{{params.severity == 'critical' AND params.channel == 'pagerduty'}}",
        config: {
          url: 'https://events.pagerduty.com/v2/enqueue',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            routing_key: '{{secrets.pagerduty_routing_key}}',
            event_action: 'trigger',
            dedup_key: 'vigil-{{params.incident_id}}',
            payload: {
              summary: 'Vigil {{params.incident_id}}: {{params.message}}',
              severity: 'critical',
              source: 'vigil-autonomous-soc',
              component: '{{params.details.affected_services}}',
              group: 'vigil-incidents',
              class: '{{params.details.incident_type}}',
              custom_details: {
                incident_id: '{{params.incident_id}}',
                root_cause: '{{params.details.root_cause}}',
                affected_services: '{{params.details.affected_services}}'
              }
            },
            links: [{ href: '{{secrets.kibana_url}}/app/vigil/incident/{{params.incident_id}}', text: 'View in Vigil Dashboard' }]
          }
        }
      },
      {
        id: 'log_notification',
        type: 'index',
        config: {
          index: 'vigil-actions',
          document: {
            '@timestamp': '{{now}}',
            action_id: '{{generate_id()}}',
            incident_id: '{{params.incident_id}}',
            agent_name: 'vigil-executor',
            action_type: 'communication',
            action_detail: 'Notification sent via {{params.channel}}',
            target_system: '{{params.channel}}',
            execution_status: 'completed'
          }
        }
      }
    ]
  },
  {
    name: 'vigil-wf-ticketing',
    description: 'Create Jira tickets with incident data',
    triggers: [{ type: 'api', enabled: true }],
    params: {
      incident_id: { type: 'string', required: true },
      summary:     { type: 'string', required: true },
      description: { type: 'string', required: true },
      severity:    { type: 'string', required: true },
      assignee:    { type: 'string', required: false }
    },
    steps: [
      {
        id: 'create_ticket',
        type: 'webhook',
        config: {
          url: '{{secrets.jira_base_url}}/rest/api/3/issue',
          method: 'POST',
          headers: {
            Authorization: 'Basic {{secrets.jira_auth}}',
            'Content-Type': 'application/json'
          },
          body: {
            fields: {
              project: { key: '{{secrets.jira_project_key}}' },
              summary: '[Vigil {{params.incident_id}}] {{params.summary}}',
              description: {
                type: 'doc', version: 1,
                content: [
                  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Incident Details' }] },
                  { type: 'paragraph', content: [{ type: 'text', text: '{{params.description}}' }] },
                  { type: 'rule' },
                  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Metadata' }] },
                  { type: 'bulletList', content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Incident ID: ', marks: [{ type: 'strong' }] }, { type: 'text', text: '{{params.incident_id}}' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Severity: ', marks: [{ type: 'strong' }] }, { type: 'text', text: '{{params.severity}}' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Created by: ', marks: [{ type: 'strong' }] }, { type: 'text', text: 'Vigil Autonomous SOC' }] }] }
                  ]}
                ]
              },
              issuetype: { name: 'Bug' },
              priority: { name: '{{map_severity_to_jira(params.severity)}}' },
              labels: ['vigil-auto', 'incident-response']
            }
          }
        }
      },
      {
        id: 'log_ticket_creation',
        type: 'index',
        config: {
          index: 'vigil-actions',
          document: {
            '@timestamp': '{{now}}',
            action_id: '{{generate_id()}}',
            incident_id: '{{params.incident_id}}',
            agent_name: 'vigil-executor',
            action_type: 'documentation',
            action_detail: 'Jira ticket created: {{step.create_ticket.response.key}}',
            target_system: 'jira',
            execution_status: 'completed',
            result_summary: 'Ticket {{step.create_ticket.response.key}} created in project {{secrets.jira_project_key}}'
          }
        }
      }
    ]
  },
  {
    name: 'vigil-wf-approval',
    description: 'Interactive Slack approval gate with buttons',
    triggers: [{ type: 'api', enabled: true }],
    params: {
      incident_id:    { type: 'string', required: true },
      action_summary: { type: 'string', required: true },
      severity:       { type: 'string', required: true },
      timeout_min:    { type: 'integer', default: 15 }
    },
    steps: [
      {
        id: 'send_approval_request',
        type: 'webhook',
        config: {
          url: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          headers: {
            Authorization: 'Bearer {{secrets.slack_bot_token}}',
            'Content-Type': 'application/json'
          },
          body: {
            channel: '{{secrets.slack_approval_channel}}',
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: 'Vigil Approval Required' } },
              { type: 'section', text: { type: 'mrkdwn', text: '*Incident:* {{params.incident_id}}\n*Severity:* {{params.severity}}\n*Timeout:* {{params.timeout_min}} minutes' } },
              { type: 'divider' },
              { type: 'section', text: { type: 'mrkdwn', text: '*Proposed Action:*\n{{params.action_summary}}' } },
              { type: 'section', text: { type: 'mrkdwn', text: 'This action requires human approval before execution. Please review and respond.' } },
              {
                type: 'actions',
                block_id: 'vigil_approval_{{params.incident_id}}',
                elements: [
                  { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'vigil_approve_{{params.incident_id}}', value: 'approved' },
                  { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'vigil_reject_{{params.incident_id}}', value: 'rejected' },
                  { type: 'button', text: { type: 'plain_text', text: 'More Info' }, action_id: 'vigil_info_{{params.incident_id}}', value: 'info' }
                ]
              },
              { type: 'context', elements: [{ type: 'mrkdwn', text: 'Auto-escalation in {{params.timeout_min}} minutes if no response' }] }
            ]
          }
        }
      },
      {
        id: 'wait_for_response',
        type: 'wait',
        config: {
          timeout: '{{params.timeout_min}}m',
          resume_on: [{ webhook_path: '/api/vigil/approval-callback', match: { incident_id: '{{params.incident_id}}' } }]
        }
      },
      {
        id: 'process_response',
        type: 'condition',
        config: {
          if: "{{step.wait_for_response.result.value == 'approved'}}",
          then: 'return_approved',
          else: 'return_rejected'
        }
      },
      {
        id: 'return_approved',
        type: 'return',
        config: { approved: true, approved_by: '{{step.wait_for_response.result.user}}' }
      },
      {
        id: 'return_rejected',
        type: 'return',
        config: { approved: false, reason: "{{step.wait_for_response.result.reason || 'Timeout or rejection'}}" }
      }
    ]
  },
  {
    name: 'vigil-wf-reporting',
    description: 'Generate incident report and index for compliance',
    triggers: [{ type: 'api', enabled: true }],
    params: {
      incident_id: { type: 'string', required: true }
    },
    steps: [
      {
        id: 'fetch_incident',
        type: 'esql',
        config: { query: 'FROM vigil-incidents | WHERE incident_id == "{{params.incident_id}}" | LIMIT 1' }
      },
      {
        id: 'fetch_actions',
        type: 'esql',
        config: { query: 'FROM vigil-actions-* | WHERE incident_id == "{{params.incident_id}}" | SORT started_at ASC' }
      },
      {
        id: 'fetch_investigation',
        type: 'esql',
        config: { query: 'FROM vigil-investigations | WHERE incident_id == "{{params.incident_id}}" | SORT created_at DESC | LIMIT 1' }
      },
      {
        id: 'compile_report',
        type: 'transform',
        config: {
          output: {
            report_id: 'RPT-{{params.incident_id}}',
            report_type: 'incident_summary',
            incident_id: '{{params.incident_id}}',
            incident: '{{step.fetch_incident.results[0]}}',
            investigation: '{{step.fetch_investigation.results[0]}}',
            actions_timeline: '{{step.fetch_actions.results}}',
            total_actions: '{{step.fetch_actions.results.length}}',
            timeline: {
              incident_created: '{{step.fetch_incident.results[0].created_at}}',
              incident_resolved: '{{step.fetch_incident.results[0].resolved_at}}',
              total_duration_seconds: '{{step.fetch_incident.results[0].total_duration_seconds}}',
              ttd_seconds: '{{step.fetch_incident.results[0].ttd_seconds}}',
              tti_seconds: '{{step.fetch_incident.results[0].tti_seconds}}',
              ttr_seconds: '{{step.fetch_incident.results[0].ttr_seconds}}',
              ttv_seconds: '{{step.fetch_incident.results[0].ttv_seconds}}'
            },
            generated_at: '{{now}}',
            generated_by: 'vigil-wf-reporting'
          }
        }
      },
      {
        id: 'index_report',
        type: 'index',
        config: { index: 'vigil-investigations', document: '{{step.compile_report.output}}' }
      }
    ]
  }
];

async function deployWorkflow(workflow) {
  try {
    const resp = await axios.post(
      `${KIBANA_URL}/api/actions/connector/_execute`,
      workflow,
      {
        headers: {
          'kbn-xsrf': 'true',
          'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log.info(`Deployed workflow: ${workflow.name} (status: ${resp.status})`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) {
      log.warn(`Workflows API not available (${err.response.status}). Skipping workflow deployment. Requires Elastic 9.3+.`);
      return false;
    }
    if (err.response?.status === 409) {
      log.warn(`Workflow already exists: ${workflow.name}, updating...`);
      try {
        await axios.put(
          `${KIBANA_URL}/api/actions/connector/_execute/${workflow.name}`,
          workflow,
          {
            headers: {
              'kbn-xsrf': 'true',
              'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );
        log.info(`Updated workflow: ${workflow.name}`);
        return true;
      } catch (updateErr) {
        log.error(`Failed to update workflow ${workflow.name}: ${updateErr.message}`);
        throw updateErr;
      }
    }
    log.error(`Failed to deploy workflow ${workflow.name}: ${err.message}`);
    throw err;
  }
}

async function run() {
  if (!KIBANA_URL) {
    log.error('KIBANA_URL is required');
    process.exit(1);
  }

  let workflowsApiAvailable = true;

  for (const workflow of workflows) {
    if (!workflowsApiAvailable) break;

    const ok = await deployWorkflow(workflow);
    if (!ok) {
      workflowsApiAvailable = false;
    }
  }

  if (!workflowsApiAvailable) {
    log.warn('Workflows API unavailable — workflows were not deployed. Requires Elastic 9.3+.');
    log.warn('Workflow definitions are stored in this script and can be deployed manually when the API is available.');
  } else {
    log.info(`All ${workflows.length} workflows deployed successfully`);
  }
}

run();
