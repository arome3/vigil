#!/usr/bin/env node

/**
 * Start the full Vigil pipeline: webhook server + alert watcher.
 *
 * Usage: node scripts/start-pipeline.js
 *
 * The webhook server runs on WEBHOOK_PORT (default 3002 to avoid conflict
 * with the WS bridge on 3000 and the UI on 3001).
 * The alert watcher polls vigil-alerts-default for new alerts and routes
 * them through the full agent pipeline.
 */

import { startServer } from '../src/webhook-server/index.js';
import { startAlertWatcher } from '../src/agents/coordinator/alert-watcher.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('pipeline');

const PORT = parseInt(process.env.WEBHOOK_PORT || '3002', 10);

log.info('Starting Vigil pipeline...');

// 1. Webhook server (Slack approval callbacks, GitHub webhooks, API routes)
startServer(PORT);
log.info(`Webhook server started on port ${PORT}`);

// 2. Alert watcher (polls for new alerts, drives agent pipeline)
startAlertWatcher();
log.info('Alert watcher started');

log.info('Pipeline ready — inject alerts to trigger the agent chain.');

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('Shutting down pipeline...');
  process.exit(0);
});
