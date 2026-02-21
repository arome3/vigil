import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Environment variables (must be set before import) ──────
process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
process.env.JIRA_USER_EMAIL = 'bot@vigil.io';
process.env.JIRA_API_TOKEN = 'test-token';
process.env.JIRA_PROJECT_KEY = 'VIG';
process.env.JIRA_ISSUE_TYPE = 'Task';

// ─── Mock setup ─────────────────────────────────────────────

const mockAxios = mock.fn();

mock.module('axios', {
  defaultExport: mockAxios
});

mock.module(import.meta.resolve('../../../src/utils/logger.js'), {
  namedExports: {
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    })
  }
});

mock.module(import.meta.resolve('../../../src/integrations/circuit-breaker.js'), {
  namedExports: {
    execBreaker: async (_name, fn) => fn(),
    getBreaker: () => null,
    resetBreaker: () => {}
  }
});

// ─── Import module under test ───────────────────────────────

const {
  createIncidentTicket,
  updateTicketStatus,
  addComment,
  SEVERITY_TO_PRIORITY
} = await import('../../../src/integrations/jira.js');

// ─── Helpers ────────────────────────────────────────────────

function makeIncident(overrides = {}) {
  return {
    incident_id: 'INC-2026-001',
    severity: 'critical',
    type: 'brute-force',
    service: 'auth-service',
    ...overrides
  };
}

function mockJiraSuccess(data = {}) {
  mockAxios.mock.resetCalls();
  mockAxios.mock.mockImplementation(async (config) => {
    // Search endpoint returns no results (no duplicate)
    if (config.method === 'GET' && config.url?.includes('/search')) {
      return { status: 200, data: { total: 0, issues: [] }, headers: {} };
    }
    return {
      status: 200,
      data: { key: 'VIG-42', id: '10001', self: 'https://test.atlassian.net/rest/api/3/issue/10001', ...data },
      headers: {}
    };
  });
}

// ─── Tests ──────────────────────────────────────────────────

describe('integrations/jira', () => {
  beforeEach(() => {
    mockJiraSuccess();
  });

  // ── SEVERITY_TO_PRIORITY mapping ────────────────────────

  describe('SEVERITY_TO_PRIORITY', () => {
    it('maps all four severity levels', () => {
      assert.equal(SEVERITY_TO_PRIORITY.critical, 'Highest');
      assert.equal(SEVERITY_TO_PRIORITY.high, 'High');
      assert.equal(SEVERITY_TO_PRIORITY.medium, 'Medium');
      assert.equal(SEVERITY_TO_PRIORITY.low, 'Low');
    });

    it('is frozen', () => {
      assert.ok(Object.isFrozen(SEVERITY_TO_PRIORITY));
    });
  });

  // ── createIncidentTicket ────────────────────────────────

  describe('createIncidentTicket', () => {
    it('creates ticket with correct ADF structure', async () => {
      const incident = makeIncident();
      const result = await createIncidentTicket(incident, 'Multiple failed logins', [{ description: 'Block IP' }]);

      assert.equal(result.key, 'VIG-42');
      assert.equal(result.id, '10001');

      // calls[0] is the search, calls[1] is the create
      const callArgs = mockAxios.mock.calls[1].arguments[0];
      assert.equal(callArgs.method, 'POST');
      assert.ok(callArgs.url.includes('/rest/api/3/issue'));

      const fields = callArgs.data.fields;
      assert.equal(fields.project.key, 'VIG');
      assert.ok(fields.summary.includes('CRITICAL'));
      assert.ok(fields.summary.includes('INC-2026-001'));

      // ADF description
      assert.equal(fields.description.type, 'doc');
      assert.equal(fields.description.version, 1);
      assert.ok(fields.description.content.length >= 2);
    });

    it('maps severity to correct priority', async () => {
      const incident = makeIncident({ severity: 'high' });
      await createIncidentTicket(incident, 'Test summary', []);

      const fields = mockAxios.mock.calls[1].arguments[0].data.fields;
      assert.equal(fields.priority.name, 'High');
    });

    it('includes correct labels with incident-id tag', async () => {
      const incident = makeIncident({ severity: 'medium' });
      await createIncidentTicket(incident, 'Test summary', []);

      const fields = mockAxios.mock.calls[1].arguments[0].data.fields;
      assert.ok(fields.labels.includes('vigil'));
      assert.ok(fields.labels.includes('severity-medium'));
      assert.ok(fields.labels.includes('auto-created'));
      assert.ok(fields.labels.includes('incident-INC-2026-001'));
    });

    it('uses JIRA_ISSUE_TYPE env var', async () => {
      const incident = makeIncident();
      await createIncidentTicket(incident, 'Test', []);

      const fields = mockAxios.mock.calls[1].arguments[0].data.fields;
      assert.equal(fields.issuetype.name, 'Task');
    });

    it('defaults to Medium priority for unknown severity', async () => {
      const incident = makeIncident({ severity: 'unknown' });
      await createIncidentTicket(incident, 'Test', []);

      const fields = mockAxios.mock.calls[1].arguments[0].data.fields;
      assert.equal(fields.priority.name, 'Medium');
    });
  });

  // ── updateTicketStatus ──────────────────────────────────

  describe('updateTicketStatus', () => {
    it('fetches transitions and applies matching one (case-insensitive)', async () => {
      let callCount = 0;
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async (config) => {
        callCount++;
        if (config.method === 'GET') {
          return {
            status: 200,
            data: {
              transitions: [
                { id: '11', name: 'In Progress' },
                { id: '21', name: 'Done' }
              ]
            },
            headers: {}
          };
        }
        return { status: 204, data: {}, headers: {} };
      });

      await updateTicketStatus('VIG-42', 'done');

      assert.equal(callCount, 2);
      const postCall = mockAxios.mock.calls[1].arguments[0];
      assert.equal(postCall.method, 'POST');
      assert.deepEqual(postCall.data.transition, { id: '21' });
    });

    it('throws when no matching transition found', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => ({
        status: 200,
        data: { transitions: [{ id: '11', name: 'In Progress' }] },
        headers: {}
      }));

      await assert.rejects(
        () => updateTicketStatus('VIG-42', 'nonexistent'),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.ok(err.message.includes('nonexistent'));
          return true;
        }
      );
    });
  });

  // ── addComment ──────────────────────────────────────────

  describe('addComment', () => {
    it('sends ADF-formatted comment body', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async () => ({
        status: 201,
        data: { id: '20001' },
        headers: {}
      }));

      const result = await addComment('VIG-42', 'Investigation complete');

      assert.equal(result.id, '20001');

      const callArgs = mockAxios.mock.calls[0].arguments[0];
      assert.ok(callArgs.url.includes('/rest/api/3/issue/VIG-42/comment'));
      assert.equal(callArgs.data.body.type, 'doc');
      assert.equal(callArgs.data.body.version, 1);
      assert.equal(callArgs.data.body.content[0].type, 'paragraph');
      assert.equal(callArgs.data.body.content[0].content[0].text, 'Investigation complete');
    });
  });

  // ── Auth header ────────────────────────────────────────

  describe('buildAuthHeader (via createIncidentTicket)', () => {
    it('uses Basic auth when email and token are set', async () => {
      const incident = makeIncident();
      await createIncidentTicket(incident, 'Test', []);

      // Search call also uses Basic auth — check calls[0]
      const headers = mockAxios.mock.calls[0].arguments[0].headers;
      const expected = Buffer.from('bot@vigil.io:test-token').toString('base64');
      assert.equal(headers.Authorization, `Basic ${expected}`);
    });
  });

  // ── addComment validation ─────────────────────────────

  describe('addComment validation', () => {
    it('throws when commentText is null', async () => {
      await assert.rejects(
        () => addComment('VIG-42', null),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          assert.ok(err.message.includes('non-empty string'));
          assert.equal(err.retryable, false);
          return true;
        }
      );
    });

    it('throws when commentText is empty string', async () => {
      await assert.rejects(
        () => addComment('VIG-42', ''),
        (err) => {
          assert.equal(err.name, 'IntegrationError');
          return true;
        }
      );
    });
  });

  // ── createIncidentTicket idempotency ──────────────────

  describe('createIncidentTicket idempotency', () => {
    it('returns existing ticket when duplicate found', async () => {
      mockAxios.mock.resetCalls();
      mockAxios.mock.mockImplementation(async (config) => {
        if (config.method === 'GET' && config.url?.includes('/search')) {
          return {
            status: 200,
            data: {
              total: 1,
              issues: [{ key: 'VIG-99', id: '99999', self: 'https://test.atlassian.net/rest/api/3/issue/99999' }]
            },
            headers: {}
          };
        }
        return { status: 200, data: {}, headers: {} };
      });

      const incident = makeIncident();
      const result = await createIncidentTicket(incident, 'Test', []);

      assert.equal(result.key, 'VIG-99');
      assert.equal(result.id, '99999');
      // Only the search call should be made, no create call
      assert.equal(mockAxios.mock.callCount(), 1, 'Should only make search call');
    });
  });
});
