// Wipes demo data for repeatable runs.
//
// Usage: node scripts/demo/cleanup.js
// npm:   npm run demo:cleanup
//
// Deletes all demo-generated data from Elasticsearch indices.
// Does NOT delete index templates, agent configs, or seed data.

import readline from 'node:readline';
import chalk from 'chalk';
import client from '../../src/utils/elastic-client.js';

const INDICES_TO_CLEAN = [
  'vigil-incidents',
  'vigil-investigations',
  'vigil-actions-*',
  'vigil-agent-telemetry',
  'vigil-alerts-*',
  'vigil-alert-claims',
  'vigil-approval-responses',
  'vigil-metrics-*',
  'vigil-learnings',
  'vigil-reports',
  'logs-auth-*',
  'logs-network-*',
  'logs-service-*',
  'github-events-*'
];

/**
 * Interactive cleanup — prompts for confirmation before deleting.
 */
export async function cleanup() {
  console.log(`\n  ${chalk.bold('VIGIL DEMO CLEANUP')}\n`);
  console.log('  The following indices will be wiped:\n');
  for (const idx of INDICES_TO_CLEAN) {
    console.log(`    ${chalk.dim('\u2022')} ${idx}`);
  }
  console.log(`\n  ${chalk.dim('Seed data (runbooks, assets, baselines, threat-intel) will be preserved.')}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('  Proceed? (y/N) ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'y') {
    console.log('  Cancelled.\n');
    return;
  }

  await deleteAllIndices();
}

/**
 * Silent cleanup — no confirmation prompt. Used by run-all.js between scenarios.
 */
export async function cleanupSilent() {
  await deleteAllIndices();
}

async function deleteAllIndices() {
  for (const idx of INDICES_TO_CLEAN) {
    try {
      const result = await client.deleteByQuery({
        index: idx,
        query: { match_all: {} },
        conflicts: 'proceed',
        refresh: true
      });
      const deleted = result.deleted || 0;
      console.log(`  ${chalk.green('\u2713')} ${idx}: ${deleted} documents deleted`);
    } catch (err) {
      if (err.meta?.statusCode === 404) {
        console.log(`  ${chalk.dim('-')} ${idx}: index not found (skipped)`);
      } else {
        console.log(`  ${chalk.red('\u2717')} ${idx}: ${err.message}`);
      }
    }
  }

  console.log(`\n  ${chalk.green('Cleanup complete.')} Ready for next demo run.\n`);
}

// Self-execute when run directly
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = resolve(fileURLToPath(import.meta.url));
const entryFile = resolve(process.argv[1]);

if (thisFile === entryFile) {
  cleanup().catch(err => {
    console.error(chalk.red(`Cleanup failed: ${err.message}`));
    process.exitCode = 1;
  });
}
