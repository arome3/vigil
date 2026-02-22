/**
 * Bridge module for lazy-loading the Analyst scheduler.
 *
 * This exists to prevent circular dependency issues between the state machine
 * and the Analyst agent. The state machine dynamically imports this bridge,
 * which in turn imports the Analyst scheduler.
 */
export { analyzeIncident } from '../agents/analyst/scheduler.js';
