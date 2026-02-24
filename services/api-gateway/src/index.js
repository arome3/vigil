// API Gateway — entry point for the Vigil demo environment.
// Fans out requests to downstream services and serves as the "bad deploy" target.
// APM is loaded via -r flag (not imported here).

const express = require('express');
const { createLogger, format, transports } = require('winston');

const PORT = Number(process.env.PORT) || 8080;
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'api-gateway';

// Downstream service URLs (injected via env in K8s/Compose)
const PAYMENT_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:8081';
const USER_URL = process.env.USER_SERVICE_URL || 'http://localhost:8082';
const NOTIFICATION_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:8083';

// Error injection: set ERROR_RATE=0.23 to simulate 23% error rate (for demo scenarios)
const ERROR_RATE = Number(process.env.ERROR_RATE) || 0;

const log = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(format.timestamp(), format.json()),
  defaultMeta: { service: { name: SERVICE_NAME } },
  transports: [new transports.Console()]
});

const app = express();
app.use(express.json());

// ─── Health endpoint ──────────────────────────────────────────────

const startTime = Date.now();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, uptime: Math.round((Date.now() - startTime) / 1000) });
});

// ─── Fan-out request handler ──────────────────────────────────────

app.post('/api/v1/requests', async (req, res) => {
  const start = Date.now();

  // Error injection: simulate service degradation when ERROR_RATE is set
  if (ERROR_RATE > 0 && Math.random() < ERROR_RATE) {
    const duration = Date.now() - start;
    log.error({
      message: 'Missing required header: X-Request-ID',
      log: { level: 'ERROR' },
      event: { outcome: 'failure' },
      http: { response: { status_code: 502 } },
      duration_ms: duration,
      injected_error: true
    });
    return res.status(502).json({ error: 'Missing required header: X-Request-ID' });
  }

  const results = {};

  try {
    // Fan out to downstream services using built-in fetch (Node 20+)
    const [paymentRes, userRes, notifyRes] = await Promise.allSettled([
      fetch(`${PAYMENT_URL}/api/v1/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: req.body.amount || 100, currency: 'USD' })
      }),
      fetch(`${USER_URL}/api/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: req.body.user_id || 'demo-user' })
      }),
      fetch(`${NOTIFICATION_URL}/api/v1/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'request_processed', user_id: req.body.user_id || 'demo-user' })
      })
    ]);

    // Extract HTTP status codes; null means network-level failure
    results.payment = paymentRes.status === 'fulfilled' ? paymentRes.value.status : null;
    results.user = userRes.status === 'fulfilled' ? userRes.value.status : null;
    results.notification = notifyRes.status === 'fulfilled' ? notifyRes.value.status : null;

    const duration = Date.now() - start;
    const hasFailure = Object.values(results).some(s => s === null || s >= 400);

    log.info({
      message: hasFailure ? 'Request completed with downstream errors' : 'Request processed successfully',
      log: { level: hasFailure ? 'ERROR' : 'INFO' },
      event: { outcome: hasFailure ? 'failure' : 'success' },
      http: { response: { status_code: hasFailure ? 502 : 200 } },
      duration_ms: duration,
      downstream: results
    });

    res.status(hasFailure ? 502 : 200).json({ status: hasFailure ? 'degraded' : 'ok', results, duration_ms: duration });
  } catch (err) {
    const duration = Date.now() - start;
    log.error({
      message: `Fan-out failed: ${err.message}`,
      log: { level: 'ERROR' },
      event: { outcome: 'failure' },
      http: { response: { status_code: 500 } },
      duration_ms: duration
    });
    res.status(500).json({ error: 'Internal gateway error' });
  }
});

// ─── Status endpoint ──────────────────────────────────────────────

app.get('/api/v1/status', async (_req, res) => {
  const checks = {};
  const services = [
    { name: 'payment-service', url: `${PAYMENT_URL}/health` },
    { name: 'user-service', url: `${USER_URL}/health` },
    { name: 'notification-svc', url: `${NOTIFICATION_URL}/health` }
  ];

  const results = await Promise.allSettled(
    services.map(s => fetch(s.url, { signal: AbortSignal.timeout(3000) }))
  );

  services.forEach((s, i) => {
    checks[s.name] = results[i].status === 'fulfilled' && results[i].value.ok ? 'healthy' : 'unhealthy';
  });

  const allHealthy = Object.values(checks).every(v => v === 'healthy');
  res.status(allHealthy ? 200 : 503).json({ status: allHealthy ? 'ok' : 'degraded', services: checks });
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
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server = app.listen(PORT, () => {
  log.info({ message: `${SERVICE_NAME} listening on port ${PORT}` });
});
