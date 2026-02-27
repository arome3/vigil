// Unified entry point for Vigil demo scenarios.
//
// Usage: node scripts/demo/run-scenario.js <1|2|3>
// npm:   npm run demo:scenario1  (routes here with arg "1")
//
// 1. Validates scenario number
// 2. Checks ES connectivity
// 3. Warns about missing optional integrations
// 4. Runs the requested scenario
// 5. Handles graceful shutdown (Ctrl+C)

import chalk from 'chalk';
import client from '../../src/utils/elastic-client.js';
import { stopPolling } from './agent-poller.js';

const scenarioNumber = parseInt(process.argv[2], 10);

if (![1, 2, 3, 4, 5, 6].includes(scenarioNumber)) {
  console.error('Usage: node scripts/demo/run-scenario.js <1|2|3|4|5|6>');
  console.error('  1 — Compromised API Key (Security Flow)');
  console.error('  2 — Cascading Deployment Failure (Operational Flow)');
  console.error('  3 — Self-Healing Failure (Reflection Loop)');
  console.error('  4 — Brute Force Login Attack (Security Flow)');
  console.error('  5 — Insider Threat — Off-Hours Data Access (Security Flow)');
  console.error('  6 — Cascading Service Failure / Memory Leak (Operational Flow)');
  process.exit(1);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n  Demo interrupted. Cleaning up...');
  stopPolling();
  process.exit(0);
});

async function preflight() {
  console.log(`\n  ${chalk.bold('VIGIL DEMO')} \u2014 Pre-flight checks\n`);

  try {
    await client.ping();
    console.log(`  ${chalk.green('\u2713')} Elasticsearch connected`);
  } catch {
    console.error(`  ${chalk.red('\u2717')} Cannot reach Elasticsearch. Check ELASTIC_URL and ELASTIC_API_KEY.`);
    process.exit(1);
  }

  const optionalVars = {
    SLACK_BOT_TOKEN: 'Slack notifications',
    JIRA_API_TOKEN: 'Jira ticket creation',
    PAGERDUTY_ROUTING_KEY: 'PagerDuty escalation'
  };

  for (const [envVar, feature] of Object.entries(optionalVars)) {
    if (process.env[envVar]) {
      console.log(`  ${chalk.green('\u2713')} ${envVar} set \u2014 ${feature} enabled`);
    } else {
      console.log(`  ${chalk.yellow('\u26A0')} ${envVar} not set \u2014 ${feature} will be simulated`);
    }
  }

  console.log('');
}

async function run() {
  await preflight();

  const scenarios = {
    1: { module: './scenario-1-compromised-key.js', fn: 'runScenario1' },
    2: { module: './scenario-2-bad-deployment.js', fn: 'runScenario2' },
    3: { module: './scenario-reflection-loop.js', fn: 'runScenario3' },
    4: { module: './scenario-3-brute-force.js', fn: 'runScenario3' },
    5: { module: './scenario-4-insider-threat.js', fn: 'runScenario4' },
    6: { module: './scenario-5-cascading-failure.js', fn: 'runScenario5' }
  };

  const { module: mod, fn } = scenarios[scenarioNumber];
  const scenarioModule = await import(mod);
  const result = await scenarioModule[fn]();

  console.log(`\n  ${chalk.bold('Scenario')} ${scenarioNumber} finished: ${result.verified ? chalk.green('VERIFIED') : chalk.yellow('INJECT ONLY')}`);
  console.log(`  Duration: ${result.duration}s\n`);
}

run().catch(err => {
  console.error(chalk.red(`\n  Fatal error: ${err.message}\n`));
  stopPolling();
  process.exitCode = 1;
});
