// Run all Vigil demo scenarios sequentially.
//
// Usage: node scripts/demo/run-all.js
//        node scripts/demo/run-all.js --skip-verify

import { runScenario1 } from './scenario-1-compromised-key.js';
import { runScenario2 } from './scenario-2-bad-deployment.js';
import { wait } from './utils.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('demo-runner');

const scenarios = [
  { name: 'Scenario 1: Compromised API Key', run: runScenario1 },
  { name: 'Scenario 2: Bad Deployment',      run: runScenario2 }
];

async function runAll() {
  const overallStart = Date.now();
  const results = [];

  console.log('\n========================================');
  console.log('  Vigil Demo — Running All Scenarios');
  console.log('========================================\n');

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];

    if (i > 0) {
      console.log('\n--- Pausing 10 seconds between scenarios ---\n');
      await wait(10_000);
    }

    const scenarioStart = Date.now();
    try {
      const result = await scenario.run();
      const duration = ((Date.now() - scenarioStart) / 1000).toFixed(1);
      results.push({ name: scenario.name, status: 'PASS', duration, verified: result.verified });
    } catch (err) {
      const duration = ((Date.now() - scenarioStart) / 1000).toFixed(1);
      log.error(`${scenario.name} failed: ${err.message}`);
      results.push({ name: scenario.name, status: 'FAIL', duration, error: err.message });
    }
  }

  // ── Summary table ─────────────────────────────────────────────────
  const totalTime = ((Date.now() - overallStart) / 1000).toFixed(1);

  console.log('\n========================================');
  console.log('  Demo Summary');
  console.log('========================================');
  console.log('');

  const nameWidth = 40;
  const statusWidth = 8;
  const durationWidth = 10;
  const verifiedWidth = 10;

  console.log(
    'Scenario'.padEnd(nameWidth) +
    'Status'.padEnd(statusWidth) +
    'Duration'.padEnd(durationWidth) +
    'Verified'.padEnd(verifiedWidth)
  );
  console.log('-'.repeat(nameWidth + statusWidth + durationWidth + verifiedWidth));

  for (const r of results) {
    const verified = r.status === 'PASS' ? (r.verified ? 'Yes' : 'No') : '-';
    console.log(
      r.name.padEnd(nameWidth) +
      r.status.padEnd(statusWidth) +
      `${r.duration}s`.padEnd(durationWidth) +
      verified.padEnd(verifiedWidth)
    );
  }

  console.log('-'.repeat(nameWidth + statusWidth + durationWidth + verifiedWidth));
  console.log(`Total: ${totalTime}s\n`);

  const failures = results.filter(r => r.status === 'FAIL');
  if (failures.length > 0) {
    console.log(`${failures.length} scenario(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('All scenarios passed.');
  }
}

runAll().catch(err => {
  log.error(`Fatal runner error: ${err.message}`);
  process.exitCode = 1;
});
