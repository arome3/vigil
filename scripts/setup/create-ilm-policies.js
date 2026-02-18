import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('ilm-policies');

const policies = [
  {
    name: 'vigil-90d-policy',
    policy: {
      phases: {
        hot: {
          actions: {
            rollover: {
              max_age: '7d',
              max_size: '10gb'
            }
          }
        },
        warm: {
          min_age: '30d',
          actions: {
            shrink: {
              number_of_shards: 1
            }
          }
        },
        delete: {
          min_age: '90d',
          actions: {
            delete: {}
          }
        }
      }
    }
  },
  {
    name: 'vigil-1y-policy',
    policy: {
      phases: {
        hot: {
          actions: {
            rollover: {
              max_age: '30d',
              max_size: '20gb'
            }
          }
        },
        warm: {
          min_age: '90d',
          actions: {
            shrink: {
              number_of_shards: 1
            }
          }
        },
        delete: {
          min_age: '365d',
          actions: {
            delete: {}
          }
        }
      }
    }
  }
];

async function run() {
  // Verify connectivity before proceeding
  const info = await client.info();
  log.info(`Connected to Elasticsearch ${info.version.number}`);

  for (const { name, policy } of policies) {
    await client.ilm.putLifecycle({ name, policy });
    log.info(`Created/updated ILM policy: ${name}`);
  }

  log.info(`All ${policies.length} ILM policies ready`);
}

run().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
