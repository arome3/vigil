// Test fixture factory functions — pure, no dependencies.
// Used by both node:test and Jest test files.

/**
 * Build a valid alert object for triage testing.
 */
export function buildAlert(overrides = {}) {
  return {
    alert_id: 'ALERT-TEST-001',
    rule_id: 'rule-brute-force-ssh',
    severity_original: 'high',
    source_ip: '10.0.0.50',
    source_user: 'alice',
    affected_asset_id: 'asset-web-prod-01',
    timestamp: '2026-02-24T10:30:00.000Z',
    ...overrides
  };
}

/**
 * Build a valid triage A2A request envelope.
 */
export function buildTriageEnvelope(alertOverrides = {}) {
  return {
    task: 'enrich_and_score',
    alert: buildAlert(alertOverrides)
  };
}

/**
 * Build an ES|QL columnar result in the {columns, values, took} format.
 *
 * @param {Array<{name: string, type: string}>} columns - Column definitions
 * @param {Array<Array>} rows - Row values (array of arrays)
 * @param {number} [took=10] - Query time in ms
 */
export function buildEsqlResult(columns, rows, took = 10) {
  return {
    columns,
    values: rows,
    took
  };
}

/**
 * Build a mock alert-enrichment ES|QL result.
 */
export function buildEnrichmentResult(overrides = {}) {
  const defaults = {
    event_count: 45,
    unique_destinations: 12,
    failed_auths: 8,
    risk_signal: 72.5
  };
  const data = { ...defaults, ...overrides };
  return buildEsqlResult(
    [
      { name: 'event_count', type: 'long' },
      { name: 'unique_destinations', type: 'long' },
      { name: 'failed_auths', type: 'long' },
      { name: 'risk_signal', type: 'double' }
    ],
    [[data.event_count, data.unique_destinations, data.failed_auths, data.risk_signal]]
  );
}

/**
 * Build a mock historical-fp-rate ES|QL result.
 */
export function buildFpRateResult(fpRate = 0.02) {
  return buildEsqlResult(
    [
      { name: 'source_type', type: 'keyword' },
      { name: 'total_incidents', type: 'long' },
      { name: 'false_positives', type: 'long' },
      { name: 'fp_rate', type: 'double' }
    ],
    [['rule-brute-force-ssh', 50, Math.round(fpRate * 50), fpRate]]
  );
}

/**
 * Build a mock asset-criticality search result.
 */
export function buildAssetResult(criticality = 'tier-1') {
  return {
    results: [
      {
        _id: 'asset-web-prod-01',
        _score: 1.0,
        asset_id: 'asset-web-prod-01',
        asset_name: 'web-prod-01',
        criticality,
        owner: 'platform-team'
      }
    ],
    total: 1,
    took: 5
  };
}

/**
 * Build a mock investigation report (investigator A2A response).
 */
export function buildInvestigationReport(overrides = {}) {
  return {
    investigation_id: 'INV-TEST-001',
    incident_id: 'INC-TEST-001',
    root_cause: 'Compromised SSH key used for lateral movement',
    attack_chain: [
      { step: 1, action: 'initial_access', detail: 'SSH brute force from 10.0.0.50' },
      { step: 2, action: 'lateral_movement', detail: 'Pivoted to 10.0.0.51 via stolen credentials' }
    ],
    blast_radius: ['10.0.0.50', '10.0.0.51', '10.0.0.52'],
    recommended_next: 'plan_remediation',
    change_correlation: { matched: false, details: null },
    ...overrides
  };
}

/**
 * Build a mock remediation plan (commander A2A response).
 */
export function buildRemediationPlan(overrides = {}) {
  return {
    incident_id: 'INC-TEST-001',
    remediation_plan: {
      actions: [
        {
          order: 1,
          action_type: 'isolate',
          description: 'Isolate compromised hosts from network',
          target_system: 'kubernetes',
          approval_required: false,
          params: { hosts: ['10.0.0.50', '10.0.0.51'] }
        },
        {
          order: 2,
          action_type: 'rotate_credentials',
          description: 'Rotate SSH keys for affected user',
          target_system: 'okta',
          approval_required: true,
          params: { user: 'alice' }
        }
      ],
      success_criteria: [
        { metric: 'error_rate', operator: 'lte', threshold: 5.0, service_name: 'api-gateway' },
        { metric: 'latency_avg', operator: 'lte', threshold: 200000, service_name: 'api-gateway' }
      ],
      estimated_duration_minutes: 15,
      ...overrides.remediation_plan
    },
    ...overrides
  };
}

/**
 * Build a mock incident document for state machine tests.
 */
export function buildIncident(overrides = {}) {
  return {
    incident_id: 'INC-TEST-001',
    status: 'detected',
    incident_type: 'security',
    severity: 'high',
    priority_score: 0.87,
    reflection_count: 0,
    created_at: '2026-02-24T10:30:00.000Z',
    updated_at: '2026-02-24T10:30:00.000Z',
    alert_timestamp: '2026-02-24T10:29:55.000Z',
    _state_timestamps: { detected: '2026-02-24T10:30:00.000Z' },
    resolution_type: null,
    resolved_at: null,
    alert_ids: ['ALERT-TEST-001'],
    source_type: 'rule-brute-force-ssh',
    ...overrides
  };
}

// ─── Integration helpers (require ES client) ────────────────

const TEST_ASSET_INDEX = 'vigil-assets-test';
const TEST_INCIDENT_INDEX = 'vigil-incidents-test';

/**
 * Seed test data into Elasticsearch indices.
 * @param {import('@elastic/elasticsearch').Client} client
 */
export async function seedAllFixtures(client) {
  const assets = [
    { asset_id: 'asset-web-prod-01', asset_name: 'web-prod-01', criticality: 'tier-1', owner: 'platform-team' },
    { asset_id: 'asset-db-staging-01', asset_name: 'db-staging-01', criticality: 'tier-2', owner: 'data-team' },
    { asset_id: 'asset-dev-vm-01', asset_name: 'dev-vm-01', criticality: 'tier-3', owner: 'dev-team' }
  ];

  const incidents = [
    buildIncident({ incident_id: 'INC-SEED-001', status: 'resolved', resolution_type: 'true_positive' }),
    buildIncident({ incident_id: 'INC-SEED-002', status: 'resolved', resolution_type: 'false_positive' }),
    buildIncident({ incident_id: 'INC-SEED-003', status: 'investigating' })
  ];

  const operations = [];
  for (const asset of assets) {
    operations.push({ index: { _index: TEST_ASSET_INDEX, _id: asset.asset_id } });
    operations.push(asset);
  }
  for (const incident of incidents) {
    operations.push({ index: { _index: TEST_INCIDENT_INDEX, _id: incident.incident_id } });
    operations.push(incident);
  }

  if (operations.length > 0) {
    await client.bulk({ operations, refresh: true });
  }
}

/**
 * Clean up test indices.
 * @param {import('@elastic/elasticsearch').Client} client
 */
export async function cleanupFixtures(client) {
  for (const index of [TEST_ASSET_INDEX, TEST_INCIDENT_INDEX]) {
    try {
      await client.indices.delete({ index, ignore_unavailable: true });
    } catch {
      // Index may not exist
    }
  }
}
