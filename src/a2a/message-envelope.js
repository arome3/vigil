import { v4 as uuidv4 } from 'uuid';

export function createEnvelope(fromAgent, toAgent, correlationId, payload) {
  return {
    message_id: `msg-${uuidv4()}`,
    from_agent: fromAgent,
    to_agent: toAgent,
    timestamp: new Date().toISOString(),
    correlation_id: correlationId,
    payload
  };
}

export function validateEnvelope(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== 'object') {
    throw new EnvelopeValidationError(['Envelope must be a non-null object']);
  }

  if (!envelope.message_id || typeof envelope.message_id !== 'string') {
    errors.push('message_id is required and must be a string');
  }
  if (!envelope.from_agent || typeof envelope.from_agent !== 'string') {
    errors.push('from_agent is required and must be a string');
  }
  if (!envelope.to_agent || typeof envelope.to_agent !== 'string') {
    errors.push('to_agent is required and must be a string');
  }
  if (!envelope.timestamp || typeof envelope.timestamp !== 'string') {
    errors.push('timestamp is required and must be an ISO 8601 string');
  }
  if (!envelope.correlation_id || typeof envelope.correlation_id !== 'string') {
    errors.push('correlation_id is required and must be a string');
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    errors.push('payload is required and must be an object');
  }

  if (errors.length > 0) {
    throw new EnvelopeValidationError(errors);
  }

  return true;
}

export class EnvelopeValidationError extends Error {
  constructor(errors) {
    super(`Invalid A2A envelope: ${errors.join('; ')}`);
    this.name = 'EnvelopeValidationError';
    this.errors = errors;
  }
}
