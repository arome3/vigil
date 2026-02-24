// Agent test harness — provides mock implementations for ES|QL tools,
// search tools, ES client, and contract validation.
//
// Usage:
//   1. Create harness: const harness = new AgentTestHarness();
//   2. Register tool results: harness.mockEsqlTool('vigil-esql-alert-enrichment', result);
//   3. Wire mocks at top level via jest.unstable_mockModule() using harness methods
//   4. After handler execution, assert on harness.getEsqlCalls(), etc.
//
// The harness does NOT call jest.unstable_mockModule() — that must be done
// at module top level before dynamic imports.

import { jest } from '@jest/globals';

export class AgentTestHarness {
  constructor() {
    /** @type {Map<string, {result?: any, error?: Error}>} */
    this._esqlResults = new Map();

    /** @type {Map<string, {result?: any, error?: Error}>} */
    this._searchResults = new Map();

    /** @type {Array<{toolName: string, params: object, options: object}>} */
    this._esqlCalls = [];

    /** @type {Array<{toolName: string, query: string, options: object}>} */
    this._searchCalls = [];

    // Create the mock functions
    this.mockExecuteEsqlTool = jest.fn(async (toolName, params, options) => {
      this._esqlCalls.push({ toolName, params, options });
      const entry = this._esqlResults.get(toolName);
      if (!entry) {
        throw new Error(`No mock registered for ES|QL tool '${toolName}'`);
      }
      if (entry.error) throw entry.error;
      return entry.result;
    });

    this.mockExecuteSearchTool = jest.fn(async (toolName, query, options) => {
      this._searchCalls.push({ toolName, query, options });
      const entry = this._searchResults.get(toolName);
      if (!entry) {
        throw new Error(`No mock registered for search tool '${toolName}'`);
      }
      if (entry.error) throw entry.error;
      return entry.result;
    });

    this.mockEsClient = {
      updateByQuery: jest.fn(async () => ({ updated: 1 })),
      search: jest.fn(async () => ({ hits: { hits: [], total: 0 } })),
      index: jest.fn(async () => ({ result: 'created' })),
      transport: {
        request: jest.fn(async () => ({ body: { columns: [], values: [] } }))
      }
    };

    this.mockValidateResponse = jest.fn(() => true);
  }

  /**
   * Register a successful ES|QL tool mock result.
   */
  mockEsqlTool(toolName, result) {
    this._esqlResults.set(toolName, { result });
    return this;
  }

  /**
   * Register an ES|QL tool failure.
   */
  failEsqlTool(toolName, error) {
    this._esqlResults.set(toolName, { error: error instanceof Error ? error : new Error(error) });
    return this;
  }

  /**
   * Register a successful search tool mock result.
   */
  mockSearchTool(toolName, result) {
    this._searchResults.set(toolName, { result });
    return this;
  }

  /**
   * Register a search tool failure.
   */
  failSearchTool(toolName, error) {
    this._searchResults.set(toolName, { error: error instanceof Error ? error : new Error(error) });
    return this;
  }

  /**
   * Get all recorded ES|QL tool invocations.
   */
  getEsqlCalls() {
    return [...this._esqlCalls];
  }

  /**
   * Get all recorded search tool invocations.
   */
  getSearchCalls() {
    return [...this._searchCalls];
  }

  /**
   * Reset all mocks and registered results.
   */
  reset() {
    this._esqlResults.clear();
    this._searchResults.clear();
    this._esqlCalls.length = 0;
    this._searchCalls.length = 0;
    this.mockExecuteEsqlTool.mockClear();
    this.mockExecuteSearchTool.mockClear();
    this.mockEsClient.updateByQuery.mockClear();
    this.mockEsClient.search.mockClear();
    this.mockEsClient.index.mockClear();
    this.mockEsClient.transport.request.mockClear();
    this.mockValidateResponse.mockClear();
  }
}

/**
 * Create a silent logger mock suitable for jest.unstable_mockModule.
 */
export function createSilentLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
}
