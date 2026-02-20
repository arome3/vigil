// Deploy all Elastic Workflow YAML definitions to the Kibana Workflows API.
// Scans src/workflows/ for *.yaml files and POSTs each as raw YAML content.
// Handles 409 (already exists → update), 404 (API unavailable → skip).

import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { createLogger } from '../../src/utils/logger.js';
import { validateWorkflowSecrets } from '../../src/workflows/secrets-manager.js';

const log = createLogger('deploy-workflows');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const WORKFLOWS_DIR = join(PROJECT_ROOT, 'src', 'workflows');

const KIBANA_URL = process.env.KIBANA_URL;
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY;

/**
 * Deploy a single workflow YAML file to the Kibana Workflows API.
 *
 * @param {string} filePath - Absolute path to the YAML file
 * @param {string} yamlContent - Raw YAML content
 * @returns {Promise<'deployed'|'updated'|'skipped'|'failed'>}
 */
async function deployWorkflow(filePath, yamlContent) {
  const name = basename(filePath, '.yaml');

  try {
    const resp = await axios.post(
      `${KIBANA_URL}/api/fleet/workflows`,
      yamlContent,
      {
        headers: {
          'kbn-xsrf': 'true',
          'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
          'Content-Type': 'application/yaml'
        }
      }
    );
    log.info(`Deployed workflow: ${name} (status: ${resp.status})`);
    return 'deployed';
  } catch (err) {
    if (err.response?.status === 404) {
      log.warn(`Workflows API not available (404). Requires Elastic 9.3+. Skipping: ${name}`);
      return 'skipped';
    }

    if (err.response?.status === 409) {
      log.warn(`Workflow already exists: ${name}, updating...`);
      try {
        await axios.put(
          `${KIBANA_URL}/api/fleet/workflows/${name}`,
          yamlContent,
          {
            headers: {
              'kbn-xsrf': 'true',
              'Authorization': `ApiKey ${ELASTIC_API_KEY}`,
              'Content-Type': 'application/yaml'
            }
          }
        );
        log.info(`Updated workflow: ${name}`);
        return 'updated';
      } catch (updateErr) {
        log.error(`Failed to update workflow ${name}: ${updateErr.message}`);
        return 'failed';
      }
    }

    log.error(`Failed to deploy workflow ${name}: ${err.message}`);
    return 'failed';
  }
}

async function run() {
  if (!KIBANA_URL) {
    log.error('KIBANA_URL is required');
    process.exit(1);
  }

  if (!ELASTIC_API_KEY) {
    log.error('ELASTIC_API_KEY is required');
    process.exit(1);
  }

  // Validate secrets (warn only, don't block deployment)
  const { valid, missing } = validateWorkflowSecrets();
  if (!valid) {
    log.warn(`${missing.length} workflow secret(s) missing — workflows may fail at runtime: ${missing.join(', ')}`);
  } else {
    log.info('All workflow secrets validated');
  }

  // Scan for YAML files
  const files = readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.yaml'))
    .sort();

  if (files.length === 0) {
    log.warn(`No YAML files found in ${WORKFLOWS_DIR}`);
    return;
  }

  log.info(`Found ${files.length} workflow file(s) in ${WORKFLOWS_DIR}`);

  const counts = { deployed: 0, updated: 0, skipped: 0, failed: 0 };
  let apiAvailable = true;

  for (const file of files) {
    if (!apiAvailable) {
      counts.skipped++;
      continue;
    }

    const filePath = join(WORKFLOWS_DIR, file);
    const yamlContent = readFileSync(filePath, 'utf-8');
    const result = await deployWorkflow(filePath, yamlContent);

    counts[result]++;

    // If the API is unavailable (404), skip remaining workflows
    if (result === 'skipped') {
      apiAvailable = false;
    }
  }

  log.info(
    `Deployment summary: ${counts.deployed} deployed, ${counts.updated} updated, ` +
    `${counts.skipped} skipped, ${counts.failed} failed`
  );

  if (!apiAvailable) {
    log.warn('Workflows API unavailable — workflows were not deployed. Requires Elastic 9.3+.');
    log.warn('Workflow YAML files are stored in src/workflows/ and can be deployed manually when the API is available.');
  }

  if (counts.failed > 0) {
    process.exit(1);
  }
}

run();
