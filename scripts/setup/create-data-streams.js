import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('data-streams');

const dataStreams = [
  'vigil-alerts-default',
  'vigil-actions-default',
  'vigil-metrics-default',
  'github-events-default'
];

const standardIndices = [
  'vigil-incidents',
  'vigil-investigations',
  'vigil-runbooks',
  'vigil-assets',
  'vigil-threat-intel',
  'vigil-baselines',
  'vigil-agent-telemetry',
  'vigil-alerts-operational',
  'vigil-alert-claims',
  'vigil-reports'
];

function isAlreadyExists(err) {
  return err.meta?.body?.error?.type === 'resource_already_exists_exception';
}

async function run() {
  const info = await client.info();
  log.info(`Connected to Elasticsearch ${info.version.number}`);

  // Create data streams
  for (const name of dataStreams) {
    try {
      await client.indices.createDataStream({ name });
      log.info(`Created data stream: ${name}`);
    } catch (err) {
      if (isAlreadyExists(err)) {
        log.warn(`Data stream already exists: ${name}`);
      } else {
        throw err;
      }
    }
  }

  // Create standard indices
  for (const index of standardIndices) {
    try {
      await client.indices.create({ index });
      log.info(`Created index: ${index}`);
    } catch (err) {
      if (isAlreadyExists(err)) {
        log.warn(`Index already exists: ${index}`);
      } else {
        throw err;
      }
    }
  }

  log.info(`All ${dataStreams.length} data streams and ${standardIndices.length} indices ready`);
}

run().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
