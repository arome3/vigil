// Typed error classes for the Executor agent.

export class ExecutionDeadlineError extends Error {
  constructor(incidentId, elapsedMs) {
    super(`Execution deadline exceeded for incident '${incidentId}' after ${elapsedMs}ms`);
    this.name = 'ExecutionDeadlineError';
    this.incidentId = incidentId;
    this.elapsedMs = elapsedMs;
  }
}
