import 'dotenv/config';
import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('inference-endpoint');

const inferenceId = 'vigil-embedding-model';

const providerConfigs = {
  elastic: () => ({
    service: 'elasticsearch',
    service_settings: {
      model_id: '.multilingual-e5-small',
      num_allocations: 1,
      num_threads: 1
    }
  }),

  openai: () => ({
    service: 'openai',
    service_settings: {
      api_key: process.env.OPENAI_API_KEY,
      model_id: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large',
      dimensions: 384
    }
  }),

  cohere: () => ({
    service: 'cohere',
    service_settings: {
      api_key: process.env.COHERE_API_KEY,
      model_id: process.env.COHERE_EMBEDDING_MODEL || 'embed-english-v3.0',
      embedding_type: 'float'
    }
  })
};

function isAlreadyExists(err) {
  return (
    err.meta?.body?.error?.type === 'resource_already_exists_exception' ||
    err.meta?.statusCode === 409
  );
}

async function run() {
  const info = await client.info();
  log.info(`Connected to Elasticsearch ${info.version.number}`);

  const provider = (process.env.EMBEDDING_PROVIDER || 'elastic').toLowerCase();
  const configFn = providerConfigs[provider];
  if (!configFn) {
    throw new Error(
      `Unknown EMBEDDING_PROVIDER "${provider}". Supported: ${Object.keys(providerConfigs).join(', ')}`
    );
  }

  const config = configFn();
  log.info(`Configuring inference endpoint "${inferenceId}" with provider: ${provider}`);

  // Check if endpoint already exists
  try {
    await client.transport.request({
      method: 'GET',
      path: `/_inference/text_embedding/${inferenceId}`
    });
    log.warn(`Inference endpoint already exists: ${inferenceId}`);
    log.info('Inference endpoint ready');
    return;
  } catch {
    // Does not exist — create it
  }

  try {
    await client.transport.request({
      method: 'PUT',
      path: `/_inference/text_embedding/${inferenceId}`,
      body: config
    });
    log.info(`Created inference endpoint: ${inferenceId}`);
  } catch (err) {
    if (isAlreadyExists(err)) {
      log.warn(`Inference endpoint already exists: ${inferenceId}`);
    } else {
      throw err;
    }
  }

  log.info('Inference endpoint ready');
}

run().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
