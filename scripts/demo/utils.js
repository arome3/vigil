// Shared simulation utilities for Vigil demo scenarios.
//
// Exports:
//   simulateAlert(alert)           — Index a single alert to vigil-alerts-default
//   simulateLogs(index, opts)      — Bulk index synthetic log events
//   simulateGitHubWebhook(event)   — Index a GitHub deployment/push event
//   simulateErrorSpike(opts)       — Bulk index service error events with cascading downstream
//   wait(ms)                       — Promise-based delay with countdown logging
//   waitForResolution(opts)        — Poll vigil-incidents for resolved status

import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('demo-utils');

// ─── Alert injection ────────────────────────────────────────────────

/**
 * Index a single enriched alert to vigil-alerts-default (data stream).
 *
 * @param {Object} alert — Alert fields (rule_id, severity_original, source, destination, affected_asset)
 * @returns {Object} — The indexed alert document with generated alert_id and @timestamp
 */
export async function simulateAlert(alert) {
  const doc = {
    '@timestamp': new Date().toISOString(),
    alert_id: `ALERT-${uuidv4().slice(0, 8).toUpperCase()}`,
    ...alert
  };

  try {
    await client.index({
      index: 'vigil-alerts-default',
      document: doc,
      refresh: 'wait_for'
    });
    log.info(`Indexed alert ${doc.alert_id} to vigil-alerts-default`);
  } catch (err) {
    log.error(`Failed to index alert: ${err.message}`);
    throw err;
  }

  return doc;
}

// ─── Log injection ──────────────────────────────────────────────────

/**
 * Bulk index synthetic log events with configurable fields.
 * Uses `create` action for data stream compatibility (append-only, auto-gen IDs).
 *
 * @param {string} index        — Target data stream (e.g., 'logs-auth-default')
 * @param {Object} opts
 * @param {number} opts.count           — Number of events to generate
 * @param {string} opts.source_ip       — Source IP address for all events
 * @param {Object} [opts.source_geo]    — Geo object { country_iso_code, city_name }
 * @param {string} [opts.destination_ip]— Destination IP address
 * @param {string} [opts.user_name]     — Username field
 * @param {string} opts.event_outcome   — Event outcome (success, failure)
 * @param {string} opts.event_action    — Event action type
 * @param {number} [opts.network_bytes] — Bytes per event (for network logs)
 * @param {number} opts.timespan_hours  — Distribute events across this many hours
 * @returns {Object} — Bulk index response summary
 */
export async function simulateLogs(index, opts) {
  const {
    count,
    source_ip,
    source_geo,
    destination_ip,
    user_name,
    event_outcome,
    event_action,
    network_bytes,
    timespan_hours
  } = opts;

  const now = Date.now();
  const spanMs = timespan_hours * 60 * 60 * 1000;
  const operations = [];

  for (let i = 0; i < count; i++) {
    const offset = (i / count) * spanMs;
    const jitter = Math.random() * (spanMs / count);
    const timestamp = new Date(now - spanMs + offset + jitter);

    const doc = {
      '@timestamp': timestamp.toISOString(),
      event: {
        action: event_action,
        outcome: event_outcome
      },
      source: {
        ip: source_ip,
        ...(source_geo && { geo: source_geo })
      },
      ...(destination_ip && {
        destination: { ip: destination_ip }
      }),
      ...(user_name && {
        user: { name: user_name }
      }),
      ...(network_bytes && {
        network: { bytes: network_bytes + Math.floor(Math.random() * 1024) }
      })
    };

    operations.push({ create: { _index: index } });
    operations.push(doc);
  }

  try {
    const result = await client.bulk({ operations, refresh: 'wait_for' });

    if (result.errors) {
      const failures = result.items.filter(item => item.create?.error);
      log.warn(`Bulk index to ${index}: ${failures.length}/${count} events failed`);
    }

    log.info(`Bulk indexed ${count} events to ${index} (took ${result.took}ms)`);
    return { indexed: count, errors: result.errors, took: result.took };
  } catch (err) {
    log.error(`Bulk index to ${index} failed: ${err.message}`);
    throw err;
  }
}

// ─── GitHub webhook injection ───────────────────────────────────────

/**
 * Index a GitHub deployment/push event to github-events-default (data stream).
 *
 * @param {Object} event — GitHub event fields (event_type, repository, branch, commit, pr, deployment, etc.)
 * @returns {Object} — The indexed event document with generated event_id and @timestamp
 */
export async function simulateGitHubWebhook(event) {
  const doc = {
    '@timestamp': new Date().toISOString(),
    event_id: `GH-${uuidv4().slice(0, 8).toUpperCase()}`,
    ...event
  };

  try {
    await client.index({
      index: 'github-events-default',
      document: doc,
      refresh: 'wait_for'
    });
    log.info(`Indexed GitHub event ${doc.event_id} to github-events-default`);
  } catch (err) {
    log.error(`Failed to index GitHub event: ${err.message}`);
    throw err;
  }

  return doc;
}

// ─── Error spike injection ──────────────────────────────────────────

/**
 * Bulk index service error events to logs-service-default (data stream).
 * Generates a mix of success and error events according to the specified error_rate.
 * 60% of total events go to the primary service; 40% are spread across downstream services.
 * Downstream error rate = primary error rate * 0.6.
 *
 * @param {Object} opts
 * @param {string} opts.service_name     — Primary service experiencing errors
 * @param {number} opts.error_rate       — Error rate as decimal (e.g., 0.23 = 23%)
 * @param {string} opts.error_message    — Error message for failed events
 * @param {number} opts.total_events     — Total number of events to generate
 * @param {number} opts.timespan_minutes — Distribute events across this many minutes
 * @param {string[]} [opts.affected_services] — Downstream services also experiencing errors
 * @returns {Object} — Bulk index response summary
 */
export async function simulateErrorSpike(opts) {
  const {
    service_name,
    error_rate,
    error_message,
    total_events,
    timespan_minutes,
    affected_services = []
  } = opts;

  const now = Date.now();
  const spanMs = timespan_minutes * 60 * 1000;
  const operations = [];

  // 60% primary / 40% downstream split
  const primaryCount = Math.floor(total_events * 0.6);
  const downstreamCount = total_events - primaryCount;
  const perService = affected_services.length > 0
    ? Math.floor(downstreamCount / affected_services.length)
    : 0;

  // Primary service events
  for (let i = 0; i < primaryCount; i++) {
    const offset = (i / primaryCount) * spanMs;
    const jitter = Math.random() * (spanMs / primaryCount);
    const timestamp = new Date(now - spanMs + offset + jitter);
    const isError = Math.random() < error_rate;

    const doc = {
      '@timestamp': timestamp.toISOString(),
      service: { name: service_name },
      log: { level: isError ? 'ERROR' : 'INFO' },
      event: { outcome: isError ? 'failure' : 'success' },
      message: isError ? error_message : 'Request processed successfully',
      http: { response: { status_code: isError ? 502 : 200 } }
    };

    operations.push({ create: { _index: 'logs-service-default' } });
    operations.push(doc);
  }

  // Downstream service events — lower error rate (cascading effect)
  for (const downstream of affected_services) {
    const downstreamErrorRate = error_rate * 0.6;
    for (let i = 0; i < perService; i++) {
      const offset = (i / perService) * spanMs;
      const jitter = Math.random() * (spanMs / perService);
      const timestamp = new Date(now - spanMs + offset + jitter);
      const isError = Math.random() < downstreamErrorRate;

      const doc = {
        '@timestamp': timestamp.toISOString(),
        service: { name: downstream },
        log: { level: isError ? 'ERROR' : 'INFO' },
        event: { outcome: isError ? 'failure' : 'success' },
        message: isError
          ? `Upstream dependency ${service_name} returned error`
          : 'Request processed successfully',
        http: { response: { status_code: isError ? 502 : 200 } }
      };

      operations.push({ create: { _index: 'logs-service-default' } });
      operations.push(doc);
    }
  }

  const actualTotal = primaryCount + (perService * affected_services.length);

  try {
    const result = await client.bulk({ operations, refresh: 'wait_for' });

    if (result.errors) {
      const failures = result.items.filter(item => item.create?.error);
      log.warn(`Error spike bulk: ${failures.length}/${actualTotal} events failed`);
    }

    log.info(`Error spike: ${actualTotal} events to logs-service-default (took ${result.took}ms)`);
    return {
      indexed: actualTotal,
      errors: result.errors,
      took: result.took,
      primary_events: primaryCount,
      downstream_events: perService * affected_services.length
    };
  } catch (err) {
    log.error(`Error spike bulk index failed: ${err.message}`);
    throw err;
  }
}

// ─── Wait utility ───────────────────────────────────────────────────

/**
 * Promise-based delay with countdown logging every 10 seconds.
 *
 * @param {number} ms — Milliseconds to wait
 * @returns {Promise<void>}
 */
export function wait(ms) {
  return new Promise(resolve => {
    const start = Date.now();
    const total = Math.ceil(ms / 1000);

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = total - elapsed;
      if (remaining > 0) {
        log.info(`  waiting... ${remaining}s remaining`);
      }
    }, 10_000);

    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, ms);
  });
}

// ─── Resolution verification ────────────────────────────────────────

/**
 * Poll vigil-incidents for a resolved incident. Returns the incident or null on timeout.
 *
 * @param {Object} opts
 * @param {number} [opts.timeoutMs=420000]  — Max time to poll (default 7 minutes)
 * @param {number} [opts.intervalMs=15000]  — Polling interval (default 15 seconds)
 * @returns {Promise<Object|null>} — The resolved incident document, or null if timed out
 */
export async function waitForResolution(opts = {}) {
  const { timeoutMs = 420_000, intervalMs = 15_000 } = opts;
  const deadline = Date.now() + timeoutMs;

  log.info(`Polling vigil-incidents for resolution (timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  while (Date.now() < deadline) {
    try {
      const result = await client.search({
        index: 'vigil-incidents',
        query: { term: { status: 'resolved' } },
        sort: [{ created_at: 'desc' }],
        size: 1
      });

      const hit = result.hits?.hits?.[0];
      if (hit) {
        log.info(`Incident resolved: ${hit._source.incident_id}`);
        return hit._source;
      }
    } catch (err) {
      log.warn(`Polling error (will retry): ${err.message}`);
    }

    await new Promise(r => setTimeout(r, intervalMs));
    const remaining = Math.round((deadline - Date.now()) / 1000);
    log.info(`  no resolution yet... ${remaining}s remaining`);
  }

  log.warn('Resolution polling timed out — pipeline may still be running');
  return null;
}

// ─── Incident polling ────────────────────────────────────────────

/**
 * Poll vigil-incidents for an incident created from a given alert.
 * Returns the incident_id string or null on timeout.
 *
 * @param {string} alertId — The alert_id to look for in the incident's alert_ids field
 * @param {number} [timeoutMs=30000] — Max time to poll
 * @returns {Promise<string|null>} — The incident_id, or null if timed out
 */
export async function waitForIncident(alertId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  log.info(`Polling vigil-incidents for incident linked to alert ${alertId}...`);

  while (Date.now() < deadline) {
    try {
      const result = await client.search({
        index: 'vigil-incidents',
        query: { term: { alert_ids: alertId } },
        size: 1
      });

      const hit = result.hits?.hits?.[0];
      if (hit) {
        const incidentId = hit._source.incident_id;
        log.info(`Incident found: ${incidentId}`);
        return incidentId;
      }
    } catch (err) {
      log.warn(`waitForIncident poll error (will retry): ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  log.warn(`waitForIncident timed out after ${timeoutMs}ms`);
  return null;
}

/**
 * Poll vigil-incidents for an incident reaching a target status.
 *
 * @param {string} incidentId — The incident_id to track
 * @param {string} targetStatus — The status to wait for (e.g., 'verifying', 'resolved')
 * @param {number} [timeoutMs=180000] — Max time to poll
 * @param {Object} [opts={}]
 * @param {number} [opts.min_reflection_count] — If set, also require reflection_count >= this value
 * @returns {Promise<boolean>} — true if matched, false on timeout
 */
export async function waitForIncidentStatus(incidentId, targetStatus, timeoutMs = 180000, opts = {}) {
  const deadline = Date.now() + timeoutMs;

  log.info(`Polling incident ${incidentId} for status "${targetStatus}"...`);

  while (Date.now() < deadline) {
    try {
      const result = await client.search({
        index: 'vigil-incidents',
        query: { term: { incident_id: incidentId } },
        size: 1
      });

      const hit = result.hits?.hits?.[0];
      if (hit) {
        const inc = hit._source;
        if (inc.status === targetStatus) {
          if (opts.min_reflection_count !== undefined) {
            if ((inc.reflection_count || 0) >= opts.min_reflection_count) {
              log.info(`Incident ${incidentId} reached "${targetStatus}" with reflection_count >= ${opts.min_reflection_count}`);
              return true;
            }
          } else {
            log.info(`Incident ${incidentId} reached status "${targetStatus}"`);
            return true;
          }
        }
      }
    } catch (err) {
      log.warn(`waitForIncidentStatus poll error (will retry): ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  log.warn(`waitForIncidentStatus timed out after ${timeoutMs}ms`);
  return false;
}
