import { createLogger } from './logger.js';

const log = createLogger('env');

/**
 * Parse an environment variable as a float threshold in [0, 1].
 * Returns the default on missing, empty, non-numeric, or out-of-range values.
 *
 * @param {string} envVar  - Environment variable name
 * @param {number} defaultVal - Default value (must be in [0, 1])
 * @returns {number}
 */
export function parseThreshold(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultVal;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    log.warn(`Invalid ${envVar}='${raw}' (must be 0.0–1.0). Using default ${defaultVal}.`);
    return defaultVal;
  }
  return parsed;
}

/**
 * Parse an environment variable as a positive integer (>= 1).
 * Returns the default on missing, empty, non-numeric, or non-positive values.
 *
 * @param {string} envVar  - Environment variable name
 * @param {number} defaultVal - Default value (must be >= 1)
 * @returns {number}
 */
export function parsePositiveInt(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultVal;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    log.warn(`Invalid ${envVar}='${raw}' (must be integer >= 1). Using default ${defaultVal}.`);
    return defaultVal;
  }
  return parsed;
}

/**
 * Parse an environment variable as a positive float (> 0).
 * Returns the default on missing, empty, non-numeric, or non-positive values.
 *
 * @param {string} envVar  - Environment variable name
 * @param {number} defaultVal - Default value (must be > 0)
 * @returns {number}
 */
export function parsePositiveFloat(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultVal;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    log.warn(`Invalid ${envVar}='${raw}' (must be positive float). Using default ${defaultVal}.`);
    return defaultVal;
  }
  return parsed;
}
