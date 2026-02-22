import { createLogger } from './logger.js';

const log = createLogger('utils:duration');

const MULTIPLIERS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };

/**
 * Parse a duration string like '30d', '14d', '1h', '60m', '300s' into milliseconds.
 *
 * @param {string} duration - Duration string matching /^\d+[dhms]$/
 * @param {number} [fallbackMs=2592000000] - Fallback in ms on bad input (default 30d)
 * @returns {number} Duration in milliseconds
 */
export function parseDuration(duration, fallbackMs = 30 * 24 * 60 * 60 * 1000) {
  if (!duration || typeof duration !== 'string') {
    log.warn(`Invalid duration value: ${String(duration)}. Using fallback ${fallbackMs}ms.`);
    return fallbackMs;
  }

  const match = duration.match(/^(\d+)([dhms])$/);
  if (!match) {
    log.warn(`Unrecognized duration format '${duration}'. Using fallback ${fallbackMs}ms.`);
    return fallbackMs;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (value === 0) {
    log.warn(`Zero-length duration '${duration}'. Using fallback ${fallbackMs}ms.`);
    return fallbackMs;
  }

  return value * MULTIPLIERS[unit];
}
