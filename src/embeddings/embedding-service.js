import 'dotenv/config';
import axios from 'axios';
import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('embedding-service');

const PROVIDER = (process.env.EMBEDDING_PROVIDER || 'elastic').toLowerCase();

const BATCH_LIMITS = { elastic: 10, openai: 100, cohere: 96 };
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// ── Retry helper ────────────────────────────────────────────

function isRetryable(err) {
  const status = err.response?.status ?? err.meta?.statusCode;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
      log.warn(`${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── Provider implementations ────────────────────────────────

async function embedViaElastic(input) {
  const body = Array.isArray(input) ? { input } : { input: [input] };
  const res = await client.transport.request({
    method: 'POST',
    path: '/_inference/text_embedding/vigil-embedding-model',
    body
  });
  return res.text_embedding.map((item) => item.embedding);
}

async function embedViaOpenAI(input) {
  const texts = Array.isArray(input) ? input : [input];
  const res = await axios.post(
    'https://api.openai.com/v1/embeddings',
    {
      input: texts,
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large',
      dimensions: 1024
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.data.map((item) => item.embedding);
}

async function embedViaCohere(input) {
  const texts = Array.isArray(input) ? input : [input];
  const res = await axios.post(
    'https://api.cohere.ai/v2/embed',
    {
      texts,
      model: process.env.COHERE_EMBEDDING_MODEL || 'embed-english-v3.0',
      input_type: 'search_document',
      embedding_types: ['float']
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.embeddings.float;
}

const providers = {
  elastic: embedViaElastic,
  openai: embedViaOpenAI,
  cohere: embedViaCohere
};

function getProvider() {
  const fn = providers[PROVIDER];
  if (!fn) {
    throw new Error(
      `Unknown EMBEDDING_PROVIDER "${PROVIDER}". Supported: ${Object.keys(providers).join(', ')}`
    );
  }
  return fn;
}

// ── Public API ──────────────────────────────────────────────

export async function embedText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('embedText requires a non-empty string');
  }
  const embedFn = getProvider();
  const results = await withRetry(() => embedFn(text), 'embedText');
  return results[0];
}

export async function embedBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedBatch requires a non-empty array of strings');
  }

  const embedFn = getProvider();
  const limit = BATCH_LIMITS[PROVIDER] || 10;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += limit) {
    const chunk = texts.slice(i, i + limit);
    const results = await withRetry(() => embedFn(chunk), `embedBatch[${i}..${i + chunk.length}]`);
    allEmbeddings.push(...results);
  }

  return allEmbeddings;
}
