import 'dotenv/config';
import cron from 'node-cron';
import { createLogger } from '../../utils/logger.js';
import { generateExecutiveSummary } from './generators/executive-summary.js';
import { generateComplianceEvidence } from './generators/compliance-evidence.js';
import { generateOperationalTrends } from './generators/operational-trends.js';
import { generateAgentPerformance } from './generators/agent-performance.js';

const log = createLogger('reporter-scheduler');

const SCHEDULES = {
  executive_daily:    process.env.REPORT_EXEC_DAILY_SCHEDULE    || '0 8 * * *',
  executive_weekly:   process.env.REPORT_EXEC_WEEKLY_SCHEDULE   || '0 8 * * 1',
  compliance_monthly: process.env.REPORT_COMPLIANCE_SCHEDULE    || '0 8 1 * *',
  operational_weekly: process.env.REPORT_OPS_WEEKLY_SCHEDULE    || '15 8 * * 1',
  agent_weekly:       process.env.REPORT_AGENT_WEEKLY_SCHEDULE  || '30 8 * * 1',
};

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/**
 * Start all report cron schedules.
 * Invalid cron expressions are logged and skipped.
 */
export function startScheduler() {
  log.info('Starting report scheduler');

  // --- Daily executive summary ---
  scheduleTask('executive_daily', SCHEDULES.executive_daily, async () => {
    log.info('Triggering daily executive summary');
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 86400000);
    await generateExecutiveSummary(
      windowStart.toISOString(),
      windowEnd.toISOString(),
      'scheduled_daily'
    );
  });

  // --- Weekly executive summary ---
  scheduleTask('executive_weekly', SCHEDULES.executive_weekly, async () => {
    log.info('Triggering weekly executive summary');
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 86400000);
    await generateExecutiveSummary(
      windowStart.toISOString(),
      windowEnd.toISOString(),
      'scheduled_weekly'
    );
  });

  // --- Monthly compliance evidence ---
  scheduleTask('compliance_monthly', SCHEDULES.compliance_monthly, async () => {
    log.info('Triggering monthly compliance evidence report');
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    await generateComplianceEvidence(
      lastMonth.toISOString(),
      thisMonth.toISOString(),
      'scheduled_monthly'
    );
  });

  // --- Weekly operational trends ---
  scheduleTask('operational_weekly', SCHEDULES.operational_weekly, async () => {
    log.info('Triggering weekly operational trends report');
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 86400000);
    await generateOperationalTrends(
      windowStart.toISOString(),
      windowEnd.toISOString(),
      'scheduled_weekly'
    );
  });

  // --- Weekly agent performance ---
  scheduleTask('agent_weekly', SCHEDULES.agent_weekly, async () => {
    log.info('Triggering weekly agent performance report');
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 86400000);
    await generateAgentPerformance(
      windowStart.toISOString(),
      windowEnd.toISOString(),
      'scheduled_weekly'
    );
  });

  log.info(`Report scheduler started with ${tasks.size} active schedules`);
  for (const [name, task] of tasks) {
    log.info(`  Schedule: ${name} → ${SCHEDULES[name]}`);
  }
}

/**
 * Schedule a single cron task with validation and error isolation.
 *
 * @param {string} name - Schedule name
 * @param {string} expression - Cron expression
 * @param {Function} callback - Async generator function
 */
function scheduleTask(name, expression, callback) {
  if (!cron.validate(expression)) {
    log.warn(`Invalid cron expression for ${name}: '${expression}'. Skipping.`);
    return;
  }

  const task = cron.schedule(expression, async () => {
    try {
      await callback();
    } catch (err) {
      log.error(`Scheduled report '${name}' failed: ${err.message}`, {
        schedule: name,
        error: err.message
      });
    }
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  tasks.set(name, task);
}

/**
 * Stop all cron schedules gracefully.
 */
export function stopScheduler() {
  log.info(`Stopping report scheduler (${tasks.size} tasks)`);
  for (const [name, task] of tasks) {
    task.stop();
    log.info(`Stopped schedule: ${name}`);
  }
  tasks.clear();
  log.info('Report scheduler stopped');
}

/**
 * Get the current schedules for observability.
 *
 * @returns {object} Map of schedule names to cron expressions
 */
export function getSchedules() {
  return { ...SCHEDULES };
}
