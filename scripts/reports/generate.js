#!/usr/bin/env node

/**
 * CLI for generating Vigil reports on demand.
 *
 * Usage:
 *   node scripts/reports/generate.js --type executive_summary --window 7d
 *   node scripts/reports/generate.js --type compliance_evidence --window 30d
 *   node scripts/reports/generate.js --type operational_trends --window 7d
 *   node scripts/reports/generate.js --type agent_performance --window 7d
 *   node scripts/reports/generate.js --type incident_detail --incident-id INC-2026-00142
 */

import 'dotenv/config';
import { createLogger } from '../../src/utils/logger.js';
import { generateExecutiveSummary } from '../../src/agents/reporter/generators/executive-summary.js';
import { generateComplianceEvidence } from '../../src/agents/reporter/generators/compliance-evidence.js';
import { generateOperationalTrends } from '../../src/agents/reporter/generators/operational-trends.js';
import { generateAgentPerformance } from '../../src/agents/reporter/generators/agent-performance.js';
import { generateIncidentDetailExport } from '../../src/agents/reporter/generators/incident-detail-export.js';

const log = createLogger('report-cli');

const VALID_TYPES = [
  'executive_summary',
  'compliance_evidence',
  'operational_trends',
  'agent_performance',
  'incident_detail'
];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--type' && argv[i + 1]) {
      args.type = argv[++i];
    } else if (argv[i] === '--window' && argv[i + 1]) {
      args.window = argv[++i];
    } else if (argv[i] === '--incident-id' && argv[i + 1]) {
      args.incidentId = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    }
  }
  return args;
}

function parseWindow(windowStr) {
  const now = new Date();
  const match = windowStr.match(/^(\d+)([dhm])$/);

  if (!match) {
    throw new Error(`Invalid window format: '${windowStr}'. Use format like 7d, 30d, 24h, or 60m`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  let ms;
  switch (unit) {
    case 'd': ms = value * 86400000; break;
    case 'h': ms = value * 3600000; break;
    case 'm': ms = value * 60000; break;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }

  const windowStart = new Date(now.getTime() - ms);
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString()
  };
}

function printUsage() {
  const usage = `
Vigil Report Generator CLI

Usage:
  node scripts/reports/generate.js --type <report_type> --window <duration>
  node scripts/reports/generate.js --type incident_detail --incident-id <id>

Report Types:
  executive_summary     High-level security operations summary
  compliance_evidence   Audit-ready compliance documentation
  operational_trends    Per-service operational health report
  agent_performance     Agent execution metrics and accuracy
  incident_detail       Full single-incident export

Window Format:
  7d    Last 7 days
  30d   Last 30 days
  24h   Last 24 hours

Examples:
  node scripts/reports/generate.js --type executive_summary --window 7d
  node scripts/reports/generate.js --type compliance_evidence --window 30d
  node scripts/reports/generate.js --type incident_detail --incident-id INC-2026-00142
`;
  process.stdout.write(usage);
}

async function run() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.type) {
    log.error('Missing --type argument');
    printUsage();
    process.exit(1);
  }

  if (!VALID_TYPES.includes(args.type)) {
    log.error(`Invalid report type: '${args.type}'. Valid types: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  // Incident detail requires --incident-id instead of --window
  if (args.type === 'incident_detail') {
    if (!args.incidentId) {
      log.error('--incident-id is required for incident_detail reports');
      process.exit(1);
    }

    log.info(`Generating incident detail export for ${args.incidentId}`);
    const report = await generateIncidentDetailExport(args.incidentId);
    log.info(`Report generated: ${report.report_id}`);
    process.exit(0);
  }

  // All other types require --window
  if (!args.window) {
    log.error('--window is required (e.g., --window 7d, --window 30d)');
    process.exit(1);
  }

  const { windowStart, windowEnd } = parseWindow(args.window);
  log.info(`Generating ${args.type} report`, { windowStart, windowEnd });

  let report;
  switch (args.type) {
    case 'executive_summary':
      report = await generateExecutiveSummary(windowStart, windowEnd, 'on_demand');
      break;
    case 'compliance_evidence':
      report = await generateComplianceEvidence(windowStart, windowEnd, 'on_demand');
      break;
    case 'operational_trends':
      report = await generateOperationalTrends(windowStart, windowEnd, 'on_demand');
      break;
    case 'agent_performance':
      report = await generateAgentPerformance(windowStart, windowEnd, 'on_demand');
      break;
  }

  log.info(`Report generated: ${report.report_id}`);
  process.exit(0);
}

run().catch(err => {
  log.error(`Report generation failed: ${err.message}`);
  process.exit(1);
});
