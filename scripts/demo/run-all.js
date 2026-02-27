// Run all 6 Vigil demo scenarios sequentially with cleanup between each.
//
// Usage: node scripts/demo/run-all.js
//        node scripts/demo/run-all.js --skip-verify

import chalk from 'chalk';
import { runScenario1 } from './scenario-1-compromised-key.js';
import { runScenario2 } from './scenario-2-bad-deployment.js';
import { runScenario3 as runScenarioReflection } from './scenario-reflection-loop.js';
import { runScenario3 as runScenarioBruteForce } from './scenario-3-brute-force.js';
import { runScenario4 } from './scenario-4-insider-threat.js';
import { runScenario5 } from './scenario-5-cascading-failure.js';
import { cleanupSilent } from './cleanup.js';
import { stopPolling } from './agent-poller.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-runner');

const scenarios = [
  { num: 1, name: 'Compromised API Key',                  run: runScenario1 },
  { num: 2, name: 'Cascading Deployment Failure',         run: runScenario2 },
  { num: 3, name: 'Self-Healing Failure (Reflection Loop)', run: runScenarioReflection },
  { num: 4, name: 'Brute Force Login Attack',             run: runScenarioBruteForce },
  { num: 5, name: 'Insider Threat (Off-Hours)',           run: runScenario4 },
  { num: 6, name: 'Cascading Service Failure',            run: runScenario5 }
];

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n  Demo interrupted. Cleaning up...');
  stopPolling();
  process.exit(0);
});

async function runAll() {
  const overallStart = Date.now();
  const results = [];

  console.log(`\n  ${chalk.bold('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557')}`);
  console.log(`  ${chalk.bold('\u2551')}   VIGIL \u2014 COMPLETE DEMO SUITE                ${chalk.bold('\u2551')}`);
  console.log(`  ${chalk.bold('\u2551')}   6 scenarios demonstrating autonomous SOC   ${chalk.bold('\u2551')}`);
  console.log(`  ${chalk.bold('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D')}\n`);

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];

    console.log(`\n  ${chalk.bold(`\u2500\u2500\u2500 Scenario ${scenario.num}: ${scenario.name} \u2500\u2500\u2500`)}\n`);

    // Auto-cleanup before each scenario
    console.log(chalk.dim('  Cleaning previous data...'));
    await cleanupSilent();

    const scenarioStart = Date.now();
    try {
      const result = await scenario.run();
      const duration = ((Date.now() - scenarioStart) / 1000).toFixed(1);
      results.push({
        num: scenario.num,
        name: scenario.name,
        status: 'PASS',
        duration,
        verified: result.verified,
        incident: result.incident
      });
    } catch (err) {
      const duration = ((Date.now() - scenarioStart) / 1000).toFixed(1);
      log.error(`${scenario.name} failed: ${err.message}`);
      results.push({
        num: scenario.num,
        name: scenario.name,
        status: 'FAIL',
        duration,
        error: err.message
      });
    }

    if (i < scenarios.length - 1) {
      console.log(chalk.dim('\n  Next scenario in 10 seconds...\n'));
      await new Promise(r => setTimeout(r, 10_000));
    }
  }

  // ── Final summary ───────────────────────────────────────────────
  printFinalSummary(results, overallStart);
}

function printFinalSummary(results, overallStart) {
  const totalTime = ((Date.now() - overallStart) / 1000).toFixed(1);
  const w = 64;
  const bar = '\u2550'.repeat(w);
  const line = (text) => {
    const stripped = text.replace(/\x1B\[[0-9;]*m/g, '');
    const pad = Math.max(0, w - stripped.length - 2);
    return `\u2551  ${text}${' '.repeat(pad)}\u2551`;
  };

  console.log('');
  console.log(`\u2554${bar}\u2557`);
  console.log(line(chalk.bold('VIGIL DEMO COMPLETE')));
  console.log(`\u2560${bar}\u2563`);
  console.log(line(''));

  for (const r of results) {
    const status = r.status === 'PASS' ? chalk.green('\u2713') : chalk.red('\u2717');
    console.log(line(`Scenario ${r.num}: ${r.name}`));

    if (r.status === 'PASS') {
      const agents = r.incident?.agents_involved?.length || '\u2014';
      const actions = r.incident?.remediation_plan?.actions?.length || '\u2014';
      const reflections = r.incident?.reflection_count || 0;
      console.log(line(`  ${status} Resolved in ${formatDuration(parseFloat(r.duration))} \u2502 ${agents} agents \u2502 ${actions} actions \u2502 ${reflections} reflections`));
    } else {
      console.log(line(`  ${status} ${chalk.red('FAILED')}: ${r.error || 'unknown error'}`));
    }
    console.log(line(''));
  }

  console.log(`\u2560${bar}\u2563`);
  console.log(line(''));

  const resolved = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(line(`Total: ${results.length} incidents, ${resolved} resolved, ${failed} failed`));
  console.log(line(`Combined time: ${formatDuration(parseFloat(totalTime))}`));
  console.log(line(''));
  console.log(line('Elastic features demonstrated:'));
  console.log(line(`  ${chalk.dim('\u2022')} Agent Builder (11 agents with ReAct reasoning)`));
  console.log(line(`  ${chalk.dim('\u2022')} ES|QL (21 parameterized tools, LOOKUP JOIN)`));
  console.log(line(`  ${chalk.dim('\u2022')} Elastic Workflows (7 automation pipelines)`));
  console.log(line(`  ${chalk.dim('\u2022')} Dense Vector Search (hybrid runbook + MITRE retrieval)`));
  console.log(line(`  ${chalk.dim('\u2022')} Data Streams + ILM (time-series event management)`));
  console.log(line(`  ${chalk.dim('\u2022')} A2A Protocol (inter-agent coordination)`));
  console.log(line(''));
  console.log(line(chalk.italic(`"11 agents. 29 tools. ${results.length} incidents. Zero humans."`)));
  console.log(line(''));
  console.log(`\u255A${bar}\u255D`);
  console.log('');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

runAll().catch(err => {
  log.error(`Fatal runner error: ${err.message}`);
  process.exitCode = 1;
});
