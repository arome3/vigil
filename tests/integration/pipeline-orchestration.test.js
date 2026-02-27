// Integration tests for the Vigil coordinator pipeline.
//
// Exercises the full orchestration flow (delegation, state machine, guards,
// contracts) with mocked ES client and A2A router.  No live Elasticsearch
// or Kibana required.
//
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/integration/pipeline-orchestration.test.js

import { jest } from '@jest/globals';

// ─── In-memory Elasticsearch document store ─────────────────────────────
//
// Provides get / index / update / search with proper _seq_no tracking so
// the state machine's optimistic concurrency control works correctly.

const esStore = new Map();
let autoIdCounter = 0;

function clearStore() {
  esStore.clear();
  autoIdCounter = 0;
}

const mockClient = {
  index: jest.fn(async ({ index, id, document }) => {
    const docId = id || `auto-${++autoIdCounter}`;
    const key = `${index}/${docId}`;
    const existing = esStore.get(key);
    const newSeq = (existing?._seq_no ?? -1) + 1;
    esStore.set(key, { doc: { ...document }, _seq_no: newSeq, _primary_term: 1 });
    return { result: existing ? 'updated' : 'created', _id: docId };
  }),

  get: jest.fn(async ({ index, id }) => {
    const key = `${index}/${id}`;
    const entry = esStore.get(key);
    if (!entry) {
      const err = new Error(`Document not found: ${key}`);
      err.meta = { statusCode: 404 };
      throw err;
    }
    return {
      _id: id,
      _source: { ...entry.doc },
      _seq_no: entry._seq_no,
      _primary_term: entry._primary_term
    };
  }),

  update: jest.fn(async ({ index, id, doc, if_seq_no, if_primary_term }) => {
    const key = `${index}/${id}`;
    const entry = esStore.get(key);
    if (!entry) {
      const err = new Error(`Document not found: ${key}`);
      err.meta = { statusCode: 404 };
      throw err;
    }
    if (if_seq_no !== undefined && entry._seq_no !== if_seq_no) {
      const err = new Error('Version conflict');
      err.meta = { statusCode: 409 };
      throw err;
    }
    esStore.set(key, {
      doc: { ...entry.doc, ...doc },
      _seq_no: entry._seq_no + 1,
      _primary_term: entry._primary_term
    });
    return { result: 'updated' };
  }),

  search: jest.fn(async () => ({ hits: { hits: [] } })),
  delete: jest.fn(async () => ({ result: 'deleted' }))
};

// ─── Module mocks (must precede all dynamic imports) ────────────────────

jest.unstable_mockModule('../../src/utils/elastic-client.js', () => ({
  default: mockClient
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
  })
}));

const mockSendA2A = jest.fn();
jest.unstable_mockModule('../../src/a2a/router.js', () => ({
  sendA2AMessage: mockSendA2A,
  A2A_TIMEOUTS: {},
  AgentTimeoutError: class extends Error {
    constructor(id, ms) { super(`Agent '${id}' timed out after ${ms}ms`); this.name = 'AgentTimeoutError'; }
  },
  A2AError: class extends Error {
    constructor(id, msg) { super(`A2A error from '${id}': ${msg}`); this.name = 'A2AError'; }
  }
}));

jest.unstable_mockModule('../../src/state-machine/analyst-bridge.js', () => ({
  analyzeIncident: jest.fn()
}));

// ─── Dynamic imports (resolved against mocked modules) ──────────────────

const { orchestrateSecurityIncident, orchestrateOperationalIncident } =
  await import('../../src/agents/coordinator/delegation.js');

const { processAlert, determineIncidentType } =
  await import('../../src/agents/coordinator/alert-watcher.js');

// ─── Fixture factories: contract-valid agent responses ──────────────────

function makeTriage(alertId, overrides = {}) {
  return {
    alert_id: alertId,
    priority_score: overrides.priorityScore ?? 0.85,
    disposition: overrides.disposition ?? 'investigate',
    enrichment: {
      correlated_event_count: 12,
      unique_destinations: 3,
      failed_auth_count: 47,
      risk_signal: 0.9,
      historical_fp_rate: 0.05,
      asset_criticality: overrides.assetCriticality ?? 'tier-1',
      source_ip: '203.0.113.42',
      source_user: 'svc-payment'
    }
  };
}

function makeInvestigation(incidentId, overrides = {}) {
  return {
    investigation_id: `INV-${incidentId}`,
    incident_id: incidentId,
    root_cause: 'Compromised API key used from anomalous geographic location',
    attack_chain: [
      { step: 1, technique: 'T1078', description: 'Valid account credentials from foreign IP' },
      { step: 2, technique: 'T1567', description: 'Data exfiltration via cloud storage' }
    ],
    blast_radius: [
      { asset_id: 'api-gateway', impact_type: 'data_access', confidence: 0.95 },
      { asset_id: 'payment-service', impact_type: 'data_exfiltration', confidence: 0.8 }
    ],
    threat_intel_matches: [
      { ioc_value: '203.0.113.42', type: 'ip', source: 'threat-feed-1' }
    ],
    change_correlation: { matched: false },
    recommended_next: overrides.recommendedNext ?? 'threat_hunt'
  };
}

function makeThreatHunt(incidentId) {
  return {
    incident_id: incidentId,
    confirmed_compromised: [
      { asset_id: 'api-gateway', evidence: 'anomalous outbound API calls to 198.51.100.10' }
    ],
    suspected_compromised: [],
    total_assets_scanned: 42,
    clean_assets: 41
  };
}

function makePlan(incidentId, overrides = {}) {
  return {
    incident_id: incidentId,
    remediation_plan: {
      actions: [
        {
          order: 1,
          action_type: 'rotate_credentials',
          description: 'Rotate compromised API key for svc-payment',
          target_system: 'secrets-manager',
          approval_required: overrides.approvalRequired ?? false
        },
        {
          order: 2,
          action_type: 'block_ip',
          description: 'Block attacker IP 203.0.113.42',
          target_system: 'firewall',
          approval_required: false
        }
      ],
      success_criteria: [
        { metric: 'error_rate', operator: 'lt', threshold: 0.01, service_name: 'api-gateway' }
      ]
    }
  };
}

function makeExecution(incidentId) {
  return {
    incident_id: incidentId,
    status: 'completed',
    actions_completed: 2,
    actions_failed: 0,
    action_results: [
      { action_type: 'rotate_credentials', status: 'completed', duration_ms: 2100 },
      { action_type: 'block_ip', status: 'completed', duration_ms: 340 }
    ]
  };
}

function makeVerification(incidentId, overrides = {}) {
  const passed = overrides.passed ?? true;
  const resp = {
    incident_id: incidentId,
    iteration: overrides.iteration ?? 1,
    health_score: overrides.healthScore ?? (passed ? 0.98 : 0.3),
    passed,
    criteria_results: [
      { metric: 'error_rate', actual: passed ? 0.002 : 0.15, threshold: 0.01, passed }
    ]
  };
  if (!passed) {
    resp.failure_analysis = 'Error rate still elevated above threshold';
  }
  return resp;
}

// ─── Test helpers ───────────────────────────────────────────────────────

function setupAgents(responseMap) {
  mockSendA2A.mockImplementation(async (agentId, envelope) => {
    const builder = responseMap[agentId];
    if (!builder) return {};
    return builder(envelope);
  });
}

function agentCallOrder() {
  return mockSendA2A.mock.calls.map(([agentId]) => agentId);
}

function getDoc(incidentId) {
  const entry = esStore.get(`vigil-incidents/${incidentId}`);
  return entry?.doc || null;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Pipeline Orchestration', () => {
  beforeEach(() => {
    clearStore();
    jest.clearAllMocks();
  });

  // Drain pending setImmediate callbacks (triggerAnalyst in transitions.js)
  afterEach(() => new Promise(resolve => setImmediate(resolve)));

  // ── 1. Security: Full happy path ────────────────────────────────────

  describe('Security Incident — Full Pipeline → Resolved', () => {
    test('flows through Investigator → Threat Hunter → Commander → Executor → Verifier', async () => {
      setupAgents({
        'vigil-investigator': (env) => makeInvestigation(env.correlation_id),
        'vigil-threat-hunter': (env) => makeThreatHunt(env.correlation_id),
        'vigil-commander': (env) => makePlan(env.correlation_id),
        'vigil-executor': (env) => makeExecution(env.correlation_id),
        'vigil-verifier': (env) => makeVerification(env.correlation_id)
      });

      const triage = makeTriage('ALERT-SEC-001');
      const result = await orchestrateSecurityIncident(triage);

      // ── Outcome ──
      expect(result.status).toBe('resolved');
      expect(result.incidentId).toMatch(/^INC-\d{4}-[A-Z0-9]{5}$/);
      expect(result.metrics).toBeDefined();

      // ── Agent call order ──
      expect(agentCallOrder()).toEqual([
        'vigil-investigator',
        'vigil-threat-hunter',
        'vigil-commander',
        'vigil-executor',
        'vigil-verifier'
      ]);

      // ── Incident document ──
      const doc = getDoc(result.incidentId);
      expect(doc.status).toBe('resolved');
      expect(doc.resolution_type).toBe('auto_resolved');
      expect(doc.incident_type).toBe('security');
      expect(doc.reflection_count).toBe(0);
      expect(doc.escalation_triggered).toBe(false);
      expect(doc.resolved_at).toBeTruthy();
      expect(doc.investigation_summary).toContain('Compromised API key');
      expect(doc.remediation_plan).toBeTruthy();
      expect(doc.affected_services).toContain('api-gateway');

      // ── State timestamps ──
      const ts = doc._state_timestamps;
      expect(ts.detected).toBeTruthy();
      expect(ts.triaged).toBeTruthy();
      expect(ts.investigating).toBeTruthy();
      expect(ts.threat_hunting).toBeTruthy();
      expect(ts.planning).toBeTruthy();
      expect(ts.executing).toBeTruthy();
      expect(ts.verifying).toBeTruthy();
      expect(ts.resolved).toBeTruthy();
    });
  });

  // ── 2. Security: Suppressed ─────────────────────────────────────────

  describe('Security Incident — Suppressed (Low Priority)', () => {
    test('suppresses without calling any agent when priority_score < 0.4', async () => {
      const triage = makeTriage('ALERT-SEC-002', { priorityScore: 0.2 });
      const result = await orchestrateSecurityIncident(triage);

      expect(result.status).toBe('suppressed');
      expect(mockSendA2A).not.toHaveBeenCalled();

      const doc = getDoc(result.incidentId);
      expect(doc.status).toBe('suppressed');
      expect(doc.resolution_type).toBe('suppressed');
    });
  });

  // ── 3. Security: Skip threat hunt ───────────────────────────────────

  describe('Security Incident — Investigator Skips Threat Hunt', () => {
    test('goes directly to Commander when recommended_next is plan_remediation', async () => {
      setupAgents({
        'vigil-investigator': (env) => makeInvestigation(env.correlation_id, { recommendedNext: 'plan_remediation' }),
        'vigil-commander': (env) => makePlan(env.correlation_id),
        'vigil-executor': (env) => makeExecution(env.correlation_id),
        'vigil-verifier': (env) => makeVerification(env.correlation_id)
      });

      const triage = makeTriage('ALERT-SEC-003');
      const result = await orchestrateSecurityIncident(triage);

      expect(result.status).toBe('resolved');

      const agents = agentCallOrder();
      expect(agents).not.toContain('vigil-threat-hunter');
      expect(agents).toEqual([
        'vigil-investigator',
        'vigil-commander',
        'vigil-executor',
        'vigil-verifier'
      ]);

      // No threat_hunting timestamp
      const doc = getDoc(result.incidentId);
      expect(doc._state_timestamps.threat_hunting).toBeUndefined();
    });
  });

  // ── 4. Security: Reflection loop → resolved ─────────────────────────

  describe('Security Incident — Reflection (Retry Then Resolve)', () => {
    test('re-investigates and re-plans after first verification failure', async () => {
      let verifyCount = 0;

      setupAgents({
        'vigil-investigator': (env) => makeInvestigation(env.correlation_id, { recommendedNext: 'plan_remediation' }),
        'vigil-commander': (env) => makePlan(env.correlation_id),
        'vigil-executor': (env) => makeExecution(env.correlation_id),
        'vigil-verifier': (env) => {
          verifyCount++;
          return makeVerification(env.correlation_id, {
            passed: verifyCount > 1,
            healthScore: verifyCount > 1 ? 0.98 : 0.3
          });
        }
      });

      const triage = makeTriage('ALERT-SEC-004');
      const result = await orchestrateSecurityIncident(triage);

      expect(result.status).toBe('resolved');

      // Verifier called twice (initial + 1 reflection)
      const agents = agentCallOrder();
      expect(agents.filter(a => a === 'vigil-verifier')).toHaveLength(2);
      expect(agents.filter(a => a === 'vigil-investigator')).toHaveLength(2);
      expect(agents.filter(a => a === 'vigil-commander')).toHaveLength(2);

      // Document shows 1 reflection occurred
      const doc = getDoc(result.incidentId);
      expect(doc.reflection_count).toBe(1);
      expect(doc.status).toBe('resolved');
      expect(doc._state_timestamps.reflecting).toBeTruthy();
    });
  });

  // ── 5. Security: Escalation (reflection limit) ──────────────────────

  describe('Security Incident — Escalation After 3 Reflections', () => {
    test('escalates to human when verifier never passes', async () => {
      setupAgents({
        'vigil-investigator': (env) => makeInvestigation(env.correlation_id, { recommendedNext: 'plan_remediation' }),
        'vigil-commander': (env) => makePlan(env.correlation_id),
        'vigil-executor': (env) => makeExecution(env.correlation_id),
        'vigil-verifier': (env) => makeVerification(env.correlation_id, { passed: false, healthScore: 0.2 })
      });

      const triage = makeTriage('ALERT-SEC-005');
      const result = await orchestrateSecurityIncident(triage);

      expect(result.status).toBe('escalated');
      expect(result.reason).toBe('reflection_limit_reached');

      // 1 initial + 3 reflections = 4 verifier calls
      const agents = agentCallOrder();
      expect(agents.filter(a => a === 'vigil-verifier')).toHaveLength(4);
      expect(agents.filter(a => a === 'vigil-investigator')).toHaveLength(4);

      // Escalation notification sent
      expect(agents.filter(a => a === 'vigil-wf-notify')).toHaveLength(1);

      // Document state
      const doc = getDoc(result.incidentId);
      expect(doc.escalation_triggered).toBe(true);
      expect(doc.reflection_count).toBe(3);
    });
  });

  // ── 6. Security: Investigation failure → escalation ─────────────────
  //
  // NOTE: delegation.js:220 attempts planning → escalated on investigation
  // failure, but the state machine only allows planning → [awaiting_approval,
  // executing]. This causes an InvalidTransitionError, which propagates up.
  // The test validates the current (buggy) behavior.

  describe('Security Incident — Investigation Failure', () => {
    test('throws InvalidTransitionError (planning → escalated is not allowed)', async () => {
      setupAgents({
        'vigil-investigator': () => { throw new Error('LLM timeout'); }
      });

      const triage = makeTriage('ALERT-SEC-006');
      await expect(orchestrateSecurityIncident(triage)).rejects.toThrow(
        /Invalid transition: planning → escalated/
      );
    });
  });

  // ── 7. Operational: Happy path ──────────────────────────────────────

  describe('Operational Incident — Sentinel → Resolved', () => {
    test('orchestrates operational flow with change correlation', async () => {
      setupAgents({
        'vigil-investigator': (env) => makeInvestigation(env.correlation_id, { recommendedNext: 'plan_remediation' }),
        'vigil-commander': (env) => makePlan(env.correlation_id),
        'vigil-executor': (env) => makeExecution(env.correlation_id),
        'vigil-verifier': (env) => makeVerification(env.correlation_id)
      });

      const sentinelReport = {
        anomaly_id: 'ANOM-001',
        detected_at: new Date().toISOString(),
        affected_service_tier: 'tier-1',
        affected_assets: ['api-gateway', 'payment-service'],
        root_cause_assessment: 'Error rate spike correlated with deployment v2.3.1',
        change_correlation: {
          matched: true,
          confidence: 'high',
          commit_author: 'dev-user',
          commit_sha: 'abc123def'
        }
      };

      const result = await orchestrateOperationalIncident(sentinelReport);

      expect(result.status).toBe('resolved');

      // Operational flow: investigator (high-confidence CC), commander, executor, verifier
      const agents = agentCallOrder();
      expect(agents[0]).toBe('vigil-investigator');
      expect(agents).not.toContain('vigil-threat-hunter');

      const doc = getDoc(result.incidentId);
      expect(doc.incident_type).toBe('operational');
      expect(doc.status).toBe('resolved');
    });
  });

  // ── 8. Operational: Skips investigation for low-confidence CC ───────

  describe('Operational Incident — Low-Confidence Change Correlation', () => {
    test('skips investigator and uses synthetic investigation report', async () => {
      setupAgents({
        'vigil-commander': (env) => makePlan(env.correlation_id),
        'vigil-executor': (env) => makeExecution(env.correlation_id),
        'vigil-verifier': (env) => makeVerification(env.correlation_id)
      });

      const sentinelReport = {
        anomaly_id: 'ANOM-002',
        detected_at: new Date().toISOString(),
        affected_service_tier: 'tier-2',
        affected_assets: ['notification-svc'],
        root_cause_assessment: 'Latency spike in notification service',
        change_correlation: { matched: false, confidence: 'low' }
      };

      const result = await orchestrateOperationalIncident(sentinelReport);

      expect(result.status).toBe('resolved');

      // Investigator should NOT be called (low confidence)
      const agents = agentCallOrder();
      expect(agents).not.toContain('vigil-investigator');
      expect(agents[0]).toBe('vigil-commander');
    });
  });

  // ── 9. Alert Processing: processAlert full flow ─────────────────────

  describe('Alert Processing — processAlert', () => {
    test('processes a security alert through triage and full pipeline', async () => {
      mockSendA2A.mockImplementation(async (agentId, envelope) => {
        if (agentId === 'vigil-triage') {
          return makeTriage(envelope.payload.alert.alert_id);
        }
        const incidentId = envelope.correlation_id;
        const responses = {
          'vigil-investigator': () => makeInvestigation(incidentId, { recommendedNext: 'plan_remediation' }),
          'vigil-commander': () => makePlan(incidentId),
          'vigil-executor': () => makeExecution(incidentId),
          'vigil-verifier': () => makeVerification(incidentId)
        };
        const builder = responses[agentId];
        return builder ? builder() : {};
      });

      const alertDoc = {
        _id: 'ALERT-E2E-001',
        _source: {
          alert_id: 'ALERT-E2E-001',
          rule_id: 'RULE-GEO-ANOMALY-001',
          severity_original: 'high',
          source_ip: '203.0.113.42',
          source_user: 'svc-payment',
          affected_asset_id: 'api-gateway'
        },
        _seq_no: 0,
        _primary_term: 1
      };

      // Seed the alert for markAlertProcessed
      esStore.set('vigil-alerts/ALERT-E2E-001', {
        doc: { ...alertDoc._source },
        _seq_no: 0,
        _primary_term: 1
      });

      await processAlert(alertDoc);

      // Triage is always the first call
      const agents = agentCallOrder();
      expect(agents[0]).toBe('vigil-triage');

      // Full pipeline ran
      expect(agents).toContain('vigil-investigator');
      expect(agents).toContain('vigil-commander');
      expect(agents).toContain('vigil-executor');
      expect(agents).toContain('vigil-verifier');

      // Alert was marked processed
      const alertEntry = esStore.get('vigil-alerts/ALERT-E2E-001');
      expect(alertEntry.doc.processed_at).toBeTruthy();
    });
  });

  // ── 10. Incident type classification ────────────────────────────────

  describe('Incident Type Classification', () => {
    test('sentinel/anomaly/ops rules are classified as operational', () => {
      expect(determineIncidentType({ rule_id: 'sentinel-error-spike' })).toBe('operational');
      expect(determineIncidentType({ rule_id: 'anomaly-latency-001' })).toBe('operational');
      expect(determineIncidentType({ rule_id: 'ops-disk-full' })).toBe('operational');
    });

    test('other rules are classified as security', () => {
      expect(determineIncidentType({ rule_id: 'RULE-GEO-ANOMALY-001' })).toBe('security');
      expect(determineIncidentType({ rule_id: 'brute-force-ssh-001' })).toBe('security');
      expect(determineIncidentType({ rule_id: 'exfil-dns-tunnel' })).toBe('security');
    });
  });
});
