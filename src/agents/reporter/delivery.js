import 'dotenv/config';
import axios from 'axios';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('reporter-delivery');

const REPORT_DELIVERY_CHANNELS = (process.env.REPORT_DELIVERY_CHANNELS || 'slack').split(',').map(c => c.trim()).filter(Boolean);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const EMAIL_API_URL = process.env.EMAIL_API_URL;
const EMAIL_API_KEY = process.env.EMAIL_API_KEY;
const EMAIL_RECIPIENTS = process.env.EMAIL_RECIPIENTS;
const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_AUTH = process.env.JIRA_AUTH;
const JIRA_PROJECT = process.env.JIRA_PROJECT || 'VIGIL';
const KIBANA_URL = process.env.KIBANA_URL;

/**
 * Deliver a report to configured channels.
 * Never throws — logs errors and sets delivery_status.
 *
 * @param {object} report - Report document
 * @returns {Promise<{ channels: string[], delivered_at: string|null, delivery_status: string }>}
 */
export async function deliverReport(report) {
  const deliveredChannels = [];
  const failedChannels = [];

  for (const channel of REPORT_DELIVERY_CHANNELS) {
    try {
      switch (channel) {
        case 'slack':
          await deliverToSlack(report);
          deliveredChannels.push('slack');
          break;
        case 'email':
          await deliverToEmail(report);
          deliveredChannels.push('email');
          break;
        case 'jira':
          await deliverToJira(report);
          deliveredChannels.push('jira');
          break;
        default:
          log.warn(`Unknown delivery channel: ${channel}`);
          failedChannels.push(channel);
      }
    } catch (err) {
      log.error(`Delivery to ${channel} failed for ${report.report_id}: ${err.message}`);
      failedChannels.push(channel);
    }
  }

  const deliveryResult = {
    channels: deliveredChannels,
    delivered_at: deliveredChannels.length > 0 ? new Date().toISOString() : null,
    delivery_status: failedChannels.length === 0 && deliveredChannels.length > 0
      ? 'delivered'
      : deliveredChannels.length > 0
        ? 'partial'
        : failedChannels.length > 0
          ? 'failed'
          : 'skipped'
  };

  // Update report delivery fields
  report.delivery = deliveryResult;
  if (deliveryResult.delivery_status === 'delivered') {
    report.status = 'delivered';
  }

  // Persist delivery status back to Elasticsearch
  try {
    await client.update({
      index: 'vigil-reports',
      id: report.report_id,
      doc: {
        delivery: deliveryResult,
        status: deliveryResult.delivery_status === 'delivered' ? 'delivered' : report.status
      }
    });
  } catch (updateErr) {
    log.warn(`Failed to persist delivery status for ${report.report_id}: ${updateErr.message}`);
  }

  log.info(`Delivery complete for ${report.report_id}: ${deliveryResult.delivery_status}`, {
    delivered: deliveredChannels,
    failed: failedChannels
  });

  return deliveryResult;
}

/**
 * Deliver report summary to Slack via webhook.
 */
async function deliverToSlack(report) {
  if (!SLACK_WEBHOOK_URL) {
    log.warn('Slack delivery skipped — SLACK_WEBHOOK_URL not configured');
    return;
  }

  const execBrief = report.sections?.find(s => s.section_id === 'exec-brief' || s.section_id === 'incident-inventory');
  const narrative = execBrief?.narrative || report.sections?.[0]?.narrative || 'Report generated.';
  const incidentCount = report.metadata?.incident_count ?? 0;
  const avgMttr = execBrief?.data?.avg_mttr_seconds;
  const autonomousRate = execBrief?.data?.autonomous_rate;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: report.report_title }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: narrative.slice(0, 3000) }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Incidents:* ${incidentCount}` },
        ...(avgMttr != null ? [{ type: 'mrkdwn', text: `*Avg MTTR:* ${avgMttr}s` }] : []),
        ...(autonomousRate != null ? [{ type: 'mrkdwn', text: `*Autonomous Rate:* ${autonomousRate}%` }] : []),
        { type: 'mrkdwn', text: `*Period:* ${report.reporting_window.start.slice(0, 10)} to ${report.reporting_window.end.slice(0, 10)}` }
      ]
    }
  ];

  if (KIBANA_URL) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View Full Report' },
        url: `${KIBANA_URL}/app/dashboards#/view/vigil-dash-reports?_a=(query:(query_string:(query:'report_id:"${report.report_id}"')))`
      }]
    });
  }

  await axios.post(SLACK_WEBHOOK_URL, { blocks }, { timeout: 10000 });
  log.info(`Delivered to Slack: ${report.report_id}`);
}

/**
 * Deliver report to email via API.
 */
async function deliverToEmail(report) {
  if (!EMAIL_API_URL) {
    log.warn('Email delivery skipped — EMAIL_API_URL not configured');
    return;
  }

  const narrative = report.sections?.map(s => `## ${s.title}\n\n${s.narrative}`).join('\n\n---\n\n') || '';

  await axios.post(
    EMAIL_API_URL,
    {
      to: EMAIL_RECIPIENTS || 'security-team@company.com',
      subject: `[Vigil] ${report.report_title}`,
      html: `<h1>${report.report_title}</h1><p>Report ID: ${report.report_id}</p><p>Period: ${report.reporting_window.start} to ${report.reporting_window.end}</p><hr/><pre>${narrative}</pre>`
    },
    {
      headers: {
        'Authorization': EMAIL_API_KEY ? `Bearer ${EMAIL_API_KEY}` : undefined,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
  log.info(`Delivered to email: ${report.report_id}`);
}

/**
 * Deliver report to Jira as a new issue.
 */
async function deliverToJira(report) {
  if (!JIRA_HOST) {
    log.warn('Jira delivery skipped — JIRA_HOST not configured');
    return;
  }

  const execBrief = report.sections?.[0]?.narrative || 'Report generated.';

  await axios.post(
    `https://${JIRA_HOST}/rest/api/3/issue`,
    {
      fields: {
        project: { key: JIRA_PROJECT },
        summary: report.report_title,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: execBrief.slice(0, 5000) }]
          }]
        },
        issuetype: { name: 'Task' },
        labels: ['vigil-report', 'compliance']
      }
    },
    {
      headers: {
        'Authorization': JIRA_AUTH ? `Basic ${JIRA_AUTH}` : undefined,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
  log.info(`Delivered to Jira: ${report.report_id}`);
}
