// Notification Service — downstream consumer for the Vigil demo environment.
// Simulates notification dispatch (email, Slack, webhook).
// APM is loaded via -r flag (not imported here).

const express = require('express');
const { createLogger, format, transports } = require('winston');

const PORT = Number(process.env.PORT) || 8083;
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'notification-svc';

// Error injection: set ERROR_RATE=0.15 to simulate upstream cascade (for demo scenarios)
const ERROR_RATE = Number(process.env.ERROR_RATE) || 0;

const log = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(format.timestamp(), format.json()),
  defaultMeta: { service: { name: SERVICE_NAME } },
  transports: [new transports.Console()]
});

const app = express();
app.use(express.json());

// In-memory notification store (demo only)
const notifications = [];
let notifyCounter = 0;

// ─── Health endpoint ──────────────────────────────────────────────

const startTime = Date.now();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, uptime: Math.round((Date.now() - startTime) / 1000) });
});

// ─── Send notification ────────────────────────────────────────────

app.post('/api/v1/notify', async (req, res) => {
  const start = Date.now();
  const { type = 'generic', user_id, channel = 'email', message } = req.body || {};

  // Simulate dispatch latency (30-120ms)
  await new Promise(r => setTimeout(r, 30 + Math.random() * 90));

  // Error injection: simulate upstream cascade failure
  if (ERROR_RATE > 0 && Math.random() < ERROR_RATE) {
    const duration = Date.now() - start;
    log.error({
      message: `Upstream dependency api-gateway returned error`,
      log: { level: 'ERROR' },
      event: { outcome: 'failure' },
      http: { response: { status_code: 502 } },
      duration_ms: duration
    });
    return res.status(502).json({ error: 'Notification dispatch failed' });
  }

  const notificationId = `NOTIFY-${String(++notifyCounter).padStart(6, '0')}`;
  const notification = {
    id: notificationId,
    type,
    user_id,
    channel,
    message: message || `Notification: ${type}`,
    status: 'sent',
    sent_at: new Date().toISOString()
  };
  notifications.push(notification);

  // Keep only last 1000 notifications in memory
  if (notifications.length > 1000) notifications.splice(0, notifications.length - 1000);

  const duration = Date.now() - start;
  log.info({
    message: `Notification sent: ${notificationId} (${type} via ${channel})`,
    log: { level: 'INFO' },
    event: { outcome: 'success' },
    http: { response: { status_code: 200 } },
    duration_ms: duration,
    notification_id: notificationId,
    type,
    channel
  });

  res.json(notification);
});

// ─── List notifications ───────────────────────────────────────────

app.get('/api/v1/notifications', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const recent = notifications.slice(-limit).reverse();

  log.info({
    message: `Listed ${recent.length} notifications`,
    log: { level: 'INFO' },
    event: { outcome: 'success' },
    http: { response: { status_code: 200 } }
  });

  res.json({ count: recent.length, notifications: recent });
});

// ─── Graceful shutdown ────────────────────────────────────────────

let server;

function shutdown(signal) {
  log.info({ message: `Received ${signal}, shutting down gracefully` });
  if (server) {
    server.close(() => {
      log.info({ message: 'Server closed' });
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server = app.listen(PORT, () => {
  log.info({ message: `${SERVICE_NAME} listening on port ${PORT}` });
});
