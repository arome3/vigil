import client from '../utils/elastic-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('embedding-pipelines');

const embeddingPipelines = [
  {
    id: 'vigil-pipeline-embed-runbooks',
    description: 'Generate content_vector embeddings for runbooks',
    input_field: 'content',
    output_field: 'content_vector'
  },
  {
    id: 'vigil-pipeline-embed-threat-intel',
    description: 'Generate description_vector embeddings for threat intel',
    input_field: 'description',
    output_field: 'description_vector'
  },
  {
    id: 'vigil-pipeline-embed-incidents',
    description: 'Generate investigation_summary_vector embeddings for incidents',
    input_field: 'investigation_summary',
    output_field: 'investigation_summary_vector'
  },
  {
    id: 'vigil-pipeline-embed-investigations',
    description: 'Generate root_cause_vector embeddings for investigations',
    input_field: 'root_cause',
    output_field: 'root_cause_vector'
  }
];

export async function createEmbeddingPipelines() {
  // Check if the inference endpoint exists before creating embedding pipelines
  try {
    await client.transport.request({
      method: 'GET',
      path: '/_inference/text_embedding/vigil-embedding-model'
    });
  } catch {
    log.warn('Inference endpoint "vigil-embedding-model" not found — skipping embedding pipelines.');
    log.warn('Vector search will be unavailable. Add ML nodes and re-run bootstrap to enable.');
    return;
  }

  for (const { id, description, input_field, output_field } of embeddingPipelines) {
    await client.ingest.putPipeline({
      id,
      description,
      processors: [
        {
          inference: {
            model_id: 'vigil-embedding-model',
            input_output: [{ input_field, output_field }]
          }
        }
      ]
    });
    log.info(`Created/updated embedding pipeline: ${id}`);
  }

  log.info(`All ${embeddingPipelines.length} embedding pipelines ready`);
}

// Allow standalone execution: node src/embeddings/ingest-pipeline.js
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  createEmbeddingPipelines().catch((err) => {
    log.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
