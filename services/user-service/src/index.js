// User Service — authentication target for the Vigil demo environment.
// Simulates user auth and profile lookups.
// APM is loaded via -r flag (not imported here).

const express = require('express');
const { createLogger, format, transports } = require('winston');

const PORT = Number(process.env.PORT) || 8082;
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'user-service';

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

// Demo user store
const users = new Map([
  ['demo-user', { id: 'demo-user', name: 'Demo User', email: 'demo@acme-corp.com', role: 'engineer' }],
  ['jsmith', { id: 'jsmith', name: 'John Smith', email: 'jsmith@acme-corp.com', role: 'admin' }],
  ['analyst-1', { id: 'analyst-1', name: 'Security Analyst', email: 'analyst@acme-corp.com', role: 'analyst' }]
]);

// ─── Health endpoint ──────────────────────────────────────────────

const startTime = Date.now();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, uptime: Math.round((Date.now() - startTime) / 1000) });
});

// ─── Auth endpoint ────────────────────────────────────────────────

app.post('/api/v1/auth', async (req, res) => {
  const start = Date.now();
  const { user_id } = req.body || {};

  // Simulate auth latency (20-80ms)
  await new Promise(r => setTimeout(r, 20 + Math.random() * 60));

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
    return res.status(502).json({ error: 'Auth service unavailable' });
  }

  const user = users.get(user_id);
  const duration = Date.now() - start;

  if (!user) {
    log.info({
      message: `Authentication failed: unknown user ${user_id}`,
      log: { level: 'ERROR' },
      event: { outcome: 'failure' },
      http: { response: { status_code: 401 } },
      duration_ms: duration,
      user_id
    });
    return res.status(401).json({ error: 'Authentication failed', user_id });
  }

  log.info({
    message: `User authenticated: ${user_id}`,
    log: { level: 'INFO' },
    event: { outcome: 'success' },
    http: { response: { status_code: 200 } },
    duration_ms: duration,
    user_id,
    role: user.role
  });

  res.json({ authenticated: true, user: { id: user.id, name: user.name, role: user.role }, token: `demo-token-${Date.now()}` });
});

// ─── User profile endpoint ────────────────────────────────────────

app.get('/api/v1/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    log.info({
      message: `User not found: ${req.params.id}`,
      log: { level: 'INFO' },
      event: { outcome: 'failure' },
      http: { response: { status_code: 404 } }
    });
    return res.status(404).json({ error: 'User not found' });
  }

  log.info({
    message: `User profile retrieved: ${req.params.id}`,
    log: { level: 'INFO' },
    event: { outcome: 'success' },
    http: { response: { status_code: 200 } }
  });
  res.json(user);
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
