import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';
import { createEmbeddingPipelines } from '../../src/embeddings/ingest-pipeline.js';

const log = createLogger('ingest-pipelines');

const githubPipeline = {
  id: 'vigil-pipeline-github',
  description: 'Transform GitHub webhook events for Vigil',
  processors: [
    // 1. Set @timestamp from ingest time
    {
      script: {
        description: 'Set @timestamp from ingest timestamp',
        source: "ctx['@timestamp'] = ctx._ingest.timestamp;"
      }
    },
    // 2. Generate event_id from delivery or hook_id with fallback
    {
      script: {
        description: 'Generate event_id from webhook metadata',
        source: [
          "def id = ctx.delivery;",
          "if (id == null) { id = ctx.hook_id; }",
          "if (id == null) { id = 'unknown'; }",
          "ctx.event_id = id + '-' + ctx._ingest.timestamp;"
        ].join('\n')
      }
    },
    // 3. Extract service_name from repository.name
    {
      script: {
        description: 'Extract service_name from repository name',
        source: [
          "def name = ctx.repository?.name;",
          "ctx.service_name = name != null ? name.replace('-', '_') : 'unknown';"
        ].join('\n')
      }
    },
    // 4. Rename commit fields
    {
      rename: {
        field: 'head_commit.id',
        target_field: 'commit.sha',
        ignore_missing: true
      }
    },
    {
      rename: {
        field: 'head_commit.message',
        target_field: 'commit.message',
        ignore_missing: true
      }
    },
    {
      rename: {
        field: 'head_commit.author.username',
        target_field: 'commit.author',
        ignore_missing: true
      }
    },
    // 5. Classify event type with proper null handling
    {
      script: {
        description: 'Classify event type',
        source: [
          "if (ctx.containsKey('deployment')) {",
          "  ctx.event_type = 'deployment';",
          "  def env = ctx.deployment?.environment;",
          "  ctx.deployment.environment = env != null ? env : 'production';",
          "  def state = ctx.deployment_status?.state;",
          "  ctx.deployment.status = state != null ? state : 'success';",
          "} else if (ctx.containsKey('pull_request') && ctx.action == 'closed' && ctx.pull_request?.merged == true) {",
          "  ctx.event_type = 'pr_merge';",
          "  ctx.pr = ['number': ctx.pull_request.number, 'title': ctx.pull_request.title, 'merged_by': ctx.pull_request.merged_by?.login];",
          "} else if (ctx.containsKey('head_commit')) {",
          "  ctx.event_type = 'push';",
          "} else {",
          "  ctx.event_type = 'other';",
          "}"
        ].join('\n')
      }
    },
    // 6. Strip unnecessary webhook fields
    {
      remove: {
        field: ['sender', 'organization', 'installation', 'hook', 'hook_id'],
        ignore_missing: true
      }
    }
  ]
};

async function run() {
  const info = await client.info();
  log.info(`Connected to Elasticsearch ${info.version.number}`);

  const { id, ...pipeline } = githubPipeline;
  await client.ingest.putPipeline({ id, ...pipeline });
  log.info(`Created/updated ingest pipeline: ${id}`);

  // Embedding pipelines (require inference endpoint to be configured first)
  await createEmbeddingPipelines();

  log.info('All ingest pipelines ready');
}

run().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
