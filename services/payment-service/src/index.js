// Payment Service — tier-1 critical service for the Vigil demo environment.
// Simulates payment processing with realistic latency and error rates.
// APM is loaded via -r flag (not imported here).

const express = require('express');
const { createLogger, format, transports } = require('winston');

const PORT = Number(process.env.PORT) || 8081;
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'payment-service';

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

// In-memory payment store (demo only, capped at 10k entries)
const MAX_PAYMENTS = 10_000;
const payments = new Map();
let paymentCounter = 0;

// ─── Health endpoint ──────────────────────────────────────────────

const startTime = Date.now();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, uptime: Math.round((Date.now() - startTime) / 1000) });
});

// ─── Process payment ──────────────────────────────────────────────

app.post('/api/v1/payments', async (req, res) => {
  const start = Date.now();
  const { amount = 100, currency = 'USD' } = req.body || {};

  // Simulate processing latency (50-200ms)
  await new Promise(r => setTimeout(r, 50 + Math.random() * 150));

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
    return res.status(502).json({ error: 'Payment processing failed' });
  }

  const paymentId = `PAY-${String(++paymentCounter).padStart(6, '0')}`;
  const payment = {
    id: paymentId,
    amount,
    currency,
    status: 'completed',
    processed_at: new Date().toISOString()
  };
  payments.set(paymentId, payment);
  if (payments.size > MAX_PAYMENTS) {
    const oldest = payments.keys().next().value;
    payments.delete(oldest);
  }

  const duration = Date.now() - start;
  log.info({
    message: 'Payment processed successfully',
    log: { level: 'INFO' },
    event: { outcome: 'success' },
    http: { response: { status_code: 200 } },
    duration_ms: duration,
    payment_id: paymentId,
    amount,
    currency
  });

  res.json(payment);
});

// ─── Get payment ──────────────────────────────────────────────────

app.get('/api/v1/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) {
    log.info({
      message: `Payment not found: ${req.params.id}`,
      log: { level: 'INFO' },
      event: { outcome: 'failure' },
      http: { response: { status_code: 404 } }
    });
    return res.status(404).json({ error: 'Payment not found' });
  }

  log.info({
    message: `Payment retrieved: ${req.params.id}`,
    'log.level': 'INFO',
    'event.outcome': 'success',
    'http.response.status_code': 200
  });
  res.json(payment);
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
