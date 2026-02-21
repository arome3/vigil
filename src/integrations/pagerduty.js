// PagerDuty Events API v2 integration — trigger and resolve incidents.

import { createLogger } from '../utils/logger.js';
import { httpRequest, withBreaker, IntegrationError } from './base-client.js';

const log = createLogger('integration-pagerduty');

const EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

function requireRoutingKey() {
  if (!process.env.PAGERDUTY_ROUTING_KEY) {
    throw new IntegrationError('PAGERDUTY_ROUTING_KEY not configured', {
      integration: 'pagerduty', retryable: false
    });
  }
}

export const SEVERITY_MAP = Object.freeze({
  critical: 'critical',
  high: 'error',
  medium: 'warning',
  low: 'info'
});

/**
 * Trigger a PagerDuty incident.
 *
 * @param {object} incident - Incident data
 * @param {string} reason - Escalation reason
 * @param {object} [customDetails] - Additional context
 * @returns {Promise<{status: string, dedup_key: string}>}
 */
export async function triggerIncident(incident, reason, customDetails) {
  requireRoutingKey();
  const dedupKey = `vigil-${incident.incident_id}`;
  log.info(`Triggering PagerDuty incident for ${incident.incident_id}`);

  const response = await withBreaker('pagerduty', () =>
    httpRequest({
      method: 'POST',
      url: EVENTS_URL,
      headers: { 'Content-Type': 'application/json' },
      data: {
        routing_key: process.env.PAGERDUTY_ROUTING_KEY,
        dedup_key: dedupKey,
        event_action: 'trigger',
        payload: {
          summary: `[Vigil] ${incident.severity?.toUpperCase()}: ${incident.incident_id} — ${reason}`,
          source: 'vigil-soc',
          severity: SEVERITY_MAP[incident.severity] || 'warning',
          component: incident.service || 'unknown',
          custom_details: {
            incident_id: incident.incident_id,
            type: incident.type,
            reason,
            ...customDetails
          }
        }
      }
    })
  );

  log.info(`PagerDuty incident triggered: ${dedupKey}`);
  return { status: response.data.status, dedup_key: dedupKey };
}

/**
 * Resolve a PagerDuty incident by its Vigil incident ID.
 *
 * @param {string} incidentId - Vigil incident_id
 * @returns {Promise<{status: string, dedup_key: string}>}
 */
export async function resolveIncident(incidentId) {
  requireRoutingKey();
  const dedupKey = `vigil-${incidentId}`;
  log.info(`Resolving PagerDuty incident for ${incidentId}`);

  const response = await withBreaker('pagerduty', () =>
    httpRequest({
      method: 'POST',
      url: EVENTS_URL,
      headers: { 'Content-Type': 'application/json' },
      data: {
        routing_key: process.env.PAGERDUTY_ROUTING_KEY,
        dedup_key: dedupKey,
        event_action: 'resolve'
      }
    })
  );

  log.info(`PagerDuty incident resolved: ${dedupKey}`);
  return { status: response.data.status, dedup_key: dedupKey };
}
