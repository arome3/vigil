import { createLogger } from './logger.js';

const log = createLogger('utils:esql-helpers');

/**
 * Build a column name → index map from ES|QL result columns.
 * Logs a warning for any expected column not found.
 *
 * @param {Array<{name: string}>} columns - ES|QL result columns
 * @param {string[]} expectedCols - Column names expected (warn if missing)
 * @param {string} toolLabel - Label for log messages
 * @returns {Record<string, number>} Column name to index mapping
 */
export function buildColIndex(columns, expectedCols, toolLabel) {
  const idx = {};
  columns.forEach((col, i) => { idx[col.name] = i; });
  for (const expected of expectedCols) {
    if (idx[expected] === undefined) {
      log.warn(`${toolLabel}: expected column '${expected}' not found in result`);
    }
  }
  return idx;
}

/**
 * Build a column name → index map, throwing if any required column is missing.
 * Optional columns produce a warning but do not throw.
 *
 * @param {Array<{name: string}>} columns - ES|QL result columns
 * @param {string[]} requiredCols - Columns that must be present (throws if missing)
 * @param {string[]} [optionalCols=[]] - Columns that are expected but not mandatory
 * @param {string} toolLabel - Label for log/error messages
 * @returns {Record<string, number>} Column name to index mapping
 * @throws {Error} If any required column is missing
 */
export function requireColIndex(columns, requiredCols, optionalCols = [], toolLabel) {
  const idx = {};
  columns.forEach((col, i) => { idx[col.name] = i; });

  const missing = requiredCols.filter(col => idx[col] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${toolLabel}: missing required column(s): ${missing.join(', ')}`
    );
  }

  for (const optional of optionalCols) {
    if (idx[optional] === undefined) {
      log.warn(`${toolLabel}: expected column '${optional}' not found in result`);
    }
  }

  return idx;
}
