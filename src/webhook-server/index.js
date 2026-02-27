// Express webhook server — routes for GitHub webhooks, Slack approval callbacks,
// and a health endpoint.

import express from 'express';
import { createLogger } from '../utils/logger.js';
import { verifyGitHubSignature, handleGitHubWebhook } from './github-handler.js';
import { verifySlackSignature } from '../integrations/slack.js';
import { handleApprovalCallback } from './approval-handler.js';
import apiRoutes from './api-routes.js';

const log = createLogger('webhook-server');

const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT) || 3000;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const app = express();

// ─── GitHub webhook route ─────────────────────────────────────────────

app.post(
  '/webhook/github',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.body.toString('utf8');

    if (!verifyGitHubSignature(GITHUB_WEBHOOK_SECRET, rawBody, signature)) {
      log.warn('GitHub webhook signature verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = req.headers['x-github-event'];
    try {
      const payload = JSON.parse(rawBody);
      const result = await handleGitHubWebhook(event, payload);
      res.status(200).json(result);
    } catch (err) {
      log.error(`GitHub webhook error: ${err.message}`);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ─── Slack approval callback route ────────────────────────────────────

// Custom middleware to capture rawBody for signature verification
const MAX_BODY_BYTES = Number(process.env.VIGIL_MAX_BODY_BYTES) || 1_048_576;

function captureRawBody(req, res, next) {
  let body = '';
  let bytes = 0;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_BODY_BYTES) {
      req.destroy(new Error('Request body too large'));
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    body += chunk;
  });
  req.on('error', (err) => {
    log.error(`Raw body capture error: ${err.message}`);
    res.status(400).json({ error: 'Bad request' });
  });
  req.on('end', () => {
    req.rawBody = body;
    next();
  });
}

app.post(
  '/api/vigil/approval-callback',
  captureRawBody,
  async (req, res) => {
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    if (!verifySlackSignature(SLACK_SIGNING_SECRET, timestamp, req.rawBody, signature)) {
      log.warn('Slack signature verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const params = new URLSearchParams(req.rawBody);
      const payload = JSON.parse(params.get('payload') || req.rawBody);
      const result = await handleApprovalCallback(payload);
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      log.error(`Approval callback error: ${err.message}`);
      // Always respond 200 to Slack to prevent retry loops
      res.status(200).json({ ok: false, error: 'Processing error' });
    }
  }
);

// ─── API routes (serves live ES data to the UI) ─────────────────────

app.use(apiRoutes);

// ─── Health endpoint ──────────────────────────────────────────────────

const startTime = Date.now();

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round((Date.now() - startTime) / 1000)
  });
});

// ─── Server start ─────────────────────────────────────────────────────

export { app };

export function startServer(port) {
  const listenPort = port || WEBHOOK_PORT;
  return app.listen(listenPort, () => {
    log.info(`Webhook server listening on port ${listenPort}`);
  });
}
