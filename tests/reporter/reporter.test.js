import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// ── Mock elastic-client before anything imports it ──────────────
// narrative.js, scheduler.js, etc. all transitively import elastic-client.js
// which requires ELASTIC_URL. Mock it to avoid that.

jest.unstable_mockModule('../../src/utils/elastic-client.js', () => ({
  default: {
    index: jest.fn().mockResolvedValue({ result: 'created' }),
    update: jest.fn().mockResolvedValue({ result: 'updated' }),
    transport: {
      request: jest.fn().mockResolvedValue({
        body: { columns: [], values: [], took: 0 }
      })
    }
  }
}));

// ── Helpers ─────────────────────────────────────────────────────

async function loadJson(relativePath) {
  const raw = await readFile(join(PROJECT_ROOT, relativePath), 'utf-8');
  return JSON.parse(raw);
}

async function loadFile(relativePath) {
  return readFile(join(PROJECT_ROOT, relativePath), 'utf-8');
}

function extractQueryParams(query) {
  const params = new Set();
  const regex = /\?(\w+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    params.add(match[1]);
  }
  return params;
}

// ── Test 1: Reporter config validity ────────────────────────────

describe('Reporter Agent', () => {
  test('test_reporter_config_valid', async () => {
    const config = await loadJson('src/agents/reporter/config.json');

    expect(config.name).toBe('vigil-reporter');
    expect(config.tools).toHaveLength(6);
    expect(config.tools).toContain('vigil-report-executive-summary');
    expect(config.tools).toContain('vigil-report-compliance-evidence');
    expect(config.tools).toContain('vigil-report-operational-trends');
    expect(config.tools).toContain('vigil-report-agent-performance');
    expect(config.tools).toContain('vigil-report-incident-detail-export');
    expect(config.tools).toContain('vigil-search-incidents-for-report');
    expect(config.trigger).toBe('scheduled');
    expect(config.execution_mode).toBe('asynchronous');
    expect(config.a2a_connections).toEqual([]);
    expect(config.system_prompt_file).toBe('system-prompt.md');
  });

  // ── Test 2: Read-only operational indices ──────────────────────

  test('test_reporter_readonly_operational', async () => {
    const config = await loadJson('src/agents/reporter/config.json');
    const roleDescriptors = config.api_key_role_descriptors;

    expect(roleDescriptors).toBeDefined();
    const role = roleDescriptors.vigil_reporter;
    expect(role).toBeDefined();
    expect(role.indices).toHaveLength(2);

    // First entry: operational indices — read only
    const readOnlyEntry = role.indices[0];
    expect(readOnlyEntry.privileges).toEqual(['read']);
    expect(readOnlyEntry.names).toContain('vigil-incidents');
    expect(readOnlyEntry.names).toContain('vigil-actions-*');
    expect(readOnlyEntry.names).toContain('vigil-learnings');
    expect(readOnlyEntry.names).toContain('vigil-agent-telemetry');

    // Second entry: vigil-reports — read + write
    const writeEntry = role.indices[1];
    expect(writeEntry.names).toEqual(['vigil-reports']);
    expect(writeEntry.privileges).toContain('read');
    expect(writeEntry.privileges).toContain('write');
  });

  // ── Test 3: ES|QL tool param consistency ──────────────────────

  test('test_esql_tool_param_consistency', async () => {
    const toolFiles = [
      'src/tools/esql/vigil-report-executive-summary.json',
      'src/tools/esql/vigil-report-compliance-evidence.json',
      'src/tools/esql/vigil-report-operational-trends.json',
      'src/tools/esql/vigil-report-agent-performance.json',
      'src/tools/esql/vigil-report-incident-detail-export.json'
    ];

    for (const file of toolFiles) {
      const tool = await loadJson(file);
      const queryParams = extractQueryParams(tool.configuration.query);
      const declaredParams = new Set(Object.keys(tool.configuration.params || {}));

      // Every ?param in the query must be declared
      for (const param of queryParams) {
        expect(declaredParams.has(param)).toBe(true);
      }

      // Every declared param should be in the query
      for (const param of declaredParams) {
        expect(queryParams.has(param)).toBe(true);
      }

      expect(tool.type).toBe('esql');
      expect(tool.tags).toContain('vigil');
      expect(tool.tags).toContain('reporter');
      expect(tool.agent).toBe('vigil-reporter');
    }
  });

  // ── Test 4: Search tool hybrid strategy ───────────────────────

  test('test_search_tool_hybrid_strategy', async () => {
    const tool = await loadJson('src/tools/search/vigil-search-incidents-for-report.json');

    expect(tool.retrieval_strategy).toBe('hybrid');
    expect(tool.vector_field).toBe('investigation_summary_vector');
    expect(tool.text_field).toBe('investigation_summary');
    expect(tool.index).toBe('vigil-incidents');
    expect(tool.type).toBe('search');
    expect(tool.tags).toContain('reporter');
    expect(tool.max_results).toBe(50);
    expect(tool.result_fields).toContain('incident_id');
  });

  // ── Test 5: Executive summary calls tool twice (current + prior) ─

  test('test_executive_summary_trend_comparison', async () => {
    // Mock executeEsqlTool at the right path
    const mockExecuteEsqlTool = jest.fn().mockResolvedValue({
      columns: [
        { name: 'total_incidents' }, { name: 'security_incidents' },
        { name: 'operational_incidents' }, { name: 'critical_count' },
        { name: 'high_count' }, { name: 'medium_count' },
        { name: 'low_count' }, { name: 'resolved_count' },
        { name: 'escalated_count' }, { name: 'suppressed_count' },
        { name: 'avg_ttd' }, { name: 'avg_tti' },
        { name: 'avg_ttr' }, { name: 'avg_ttv' },
        { name: 'avg_total_duration' }, { name: 'total_reflections' },
        { name: 'first_attempt_resolutions' }, { name: 'autonomous_rate' },
        { name: 'suppression_rate' }, { name: 'first_attempt_rate' },
        { name: 'avg_ttd_display' }, { name: 'avg_tti_display' },
        { name: 'avg_ttr_display' }, { name: 'avg_total_display' }
      ],
      values: [[10, 7, 3, 1, 2, 4, 3, 8, 1, 1, 5, 30, 120, 60, 215, 2, 6, 80.0, 10.0, 75.0, 5, 30, 120, 215]],
      took: 5
    });

    jest.unstable_mockModule('../../src/tools/esql/executor.js', () => ({
      executeEsqlTool: mockExecuteEsqlTool
    }));

    jest.unstable_mockModule('../../src/agents/reporter/delivery.js', () => ({
      deliverReport: jest.fn().mockResolvedValue({ delivery_status: 'skipped' })
    }));

    const { generateExecutiveSummary } = await import(
      '../../src/agents/reporter/generators/executive-summary.js'
    );

    const report = await generateExecutiveSummary(
      '2026-02-15T00:00:00.000Z',
      '2026-02-22T00:00:00.000Z',
      'scheduled_weekly'
    );

    // Verify executeEsqlTool was called twice (current + prior window)
    expect(mockExecuteEsqlTool).toHaveBeenCalledTimes(2);

    // First call: current window
    expect(mockExecuteEsqlTool).toHaveBeenCalledWith(
      'vigil-report-executive-summary',
      expect.objectContaining({
        window_start: '2026-02-15T00:00:00.000Z',
        window_end: '2026-02-22T00:00:00.000Z'
      })
    );

    // Second call: prior window (window_end = current window_start)
    expect(mockExecuteEsqlTool).toHaveBeenCalledWith(
      'vigil-report-executive-summary',
      expect.objectContaining({
        window_end: '2026-02-15T00:00:00.000Z'
      })
    );

    // Report should exist
    expect(report).toBeDefined();
    expect(report.report_id).toBeDefined();
  });

  // ── Test 6: Compliance control mapping ────────────────────────

  test('test_compliance_control_mapping', async () => {
    const systemPrompt = await loadFile('src/agents/reporter/system-prompt.md');

    expect(systemPrompt).toContain('SOC 2 Type II');
    expect(systemPrompt).toContain('CC7.2');
    expect(systemPrompt).toContain('CC7.3');
    expect(systemPrompt).toContain('CC7.4');
    expect(systemPrompt).toContain('ISO 27001');
    expect(systemPrompt).toContain('A.5.24');
    expect(systemPrompt).toContain('A.5.25');
    expect(systemPrompt).toContain('A.5.26');
    expect(systemPrompt).toContain('A.5.27');
    expect(systemPrompt).toContain('GDPR Article 33');

    const complianceSource = await loadFile('src/agents/reporter/generators/compliance-evidence.js');
    expect(complianceSource).toContain("'SOC2-CC7.2'");
    expect(complianceSource).toContain("'SOC2-CC7.3'");
    expect(complianceSource).toContain("'SOC2-CC7.4'");
    expect(complianceSource).toContain("'ISO27001-A.5.24'");
    expect(complianceSource).toContain("'ISO27001-A.5.25'");
    expect(complianceSource).toContain("'ISO27001-A.5.26'");
    expect(complianceSource).toContain("'ISO27001-A.5.27'");
    expect(complianceSource).toContain("'GDPR-Art33'");

    // Structural: verify the reporter config references the compliance tool
    const compConfig = await loadJson('src/agents/reporter/config.json');
    expect(compConfig.tools).toContain('vigil-report-compliance-evidence');
  });

  // ── Test 7: Report document structure ─────────────────────────

  test('test_report_document_structure', async () => {
    const { buildReportEnvelope } = await import(
      '../../src/agents/reporter/narrative.js'
    );

    const report = buildReportEnvelope({
      reportId: 'RPT-EXEC-2026-02-22-W08',
      reportType: 'executive_summary',
      title: 'Test Report',
      windowStart: '2026-02-15T00:00:00.000Z',
      windowEnd: '2026-02-22T00:00:00.000Z',
      triggerType: 'scheduled_weekly',
      sections: [{
        section_id: 'test',
        title: 'Test Section',
        narrative: 'Test narrative',
        data: { test: true },
        source_query: 'FROM vigil-incidents | STATS COUNT(*)',
        compliance_controls: []
      }],
      metadata: {
        incident_count: 10,
        data_sources: ['vigil-incidents'],
        methodology: 'Test methodology',
        token_estimate: 100
      }
    });

    expect(report.report_id).toBe('RPT-EXEC-2026-02-22-W08');
    expect(report.report_type).toBe('executive_summary');
    expect(report.reporting_window.start).toBe('2026-02-15T00:00:00.000Z');
    expect(report.reporting_window.end).toBe('2026-02-22T00:00:00.000Z');
    expect(report.generated_by).toBe('vigil-reporter');
    expect(report.generated_at).toBeDefined();
    expect(report['@timestamp']).toBeDefined();
    expect(report.trigger_type).toBe('scheduled_weekly');
    expect(report.status).toBe('generated');
    expect(report.sections[0].source_query).toContain('vigil-incidents');
    expect(report.metadata.methodology).toBeDefined();
    expect(report.metadata.data_sources).toContain('vigil-incidents');
  });

  // ── Test 8: Report ID format ──────────────────────────────────

  test('test_report_id_format', async () => {
    const { generateReportId } = await import(
      '../../src/agents/reporter/narrative.js'
    );

    const regex = /^RPT-(EXEC|COMP|OPS|AGENT|INC)-\d{4}-\d{2}-\d{2}-.+$/;

    const execDaily = generateReportId('EXEC', '2026-03-17T08:00:00.000Z', 'scheduled_daily');
    expect(execDaily).toMatch(regex);
    expect(execDaily).toMatch(/^RPT-EXEC-2026-03-17-D\d{3}$/);

    const execWeekly = generateReportId('EXEC', '2026-03-17T08:00:00.000Z', 'scheduled_weekly');
    expect(execWeekly).toMatch(regex);
    expect(execWeekly).toMatch(/^RPT-EXEC-2026-03-17-W\d{2}$/);

    const compMonthly = generateReportId('COMP', '2026-04-01T08:00:00.000Z', 'scheduled_monthly');
    expect(compMonthly).toMatch(regex);
    expect(compMonthly).toContain('RPT-COMP-');

    const opsWeekly = generateReportId('OPS', '2026-03-17T08:00:00.000Z', 'scheduled_weekly');
    expect(opsWeekly).toMatch(regex);

    const incDetail = generateReportId('INC', '2026-03-17T08:00:00.000Z', 'on_demand', 'INC-2026-00142');
    expect(incDetail).toMatch(regex);
    expect(incDetail).toContain('INC-2026-00142');
  });

  // ── Test 9: Scheduler env override ────────────────────────────

  test('test_scheduler_env_override', async () => {
    process.env.REPORT_EXEC_DAILY_SCHEDULE = '30 9 * * *';

    const { getSchedules } = await import(
      '../../src/agents/reporter/scheduler.js'
    );

    const schedules = getSchedules();
    expect(schedules.executive_daily).toBe('30 9 * * *');

    delete process.env.REPORT_EXEC_DAILY_SCHEDULE;
  });

  // ── Test 10: Delivery missing channel ─────────────────────────

  test('test_delivery_missing_channel', async () => {
    const origSlack = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    process.env.REPORT_DELIVERY_CHANNELS = 'slack';

    const { deliverReport } = await import(
      '../../src/agents/reporter/delivery.js'
    );

    const mockReport = {
      report_id: 'RPT-TEST-2026-01-01-D001',
      report_title: 'Test Report',
      report_type: 'executive_summary',
      reporting_window: { start: '2026-01-01', end: '2026-01-02' },
      sections: [],
      metadata: { incident_count: 0 },
      delivery: {},
      status: 'generated'
    };

    // Should NOT throw
    const result = await deliverReport(mockReport);
    expect(result).toBeDefined();
    expect(result.delivery_status).toBeDefined();

    if (origSlack) process.env.SLACK_WEBHOOK_URL = origSlack;
  });

  // ── Test 11: Reporter never writes operational ────────────────

  test('test_reporter_never_writes_operational', async () => {
    const generatorFiles = [
      'src/agents/reporter/generators/executive-summary.js',
      'src/agents/reporter/generators/compliance-evidence.js',
      'src/agents/reporter/generators/operational-trends.js',
      'src/agents/reporter/generators/agent-performance.js',
      'src/agents/reporter/generators/incident-detail-export.js',
      'src/agents/reporter/narrative.js'
    ];

    for (const file of generatorFiles) {
      const source = await loadFile(file);

      // Find all client.index() calls
      const indexCalls = source.match(/client\.index\(\{[^}]*index:\s*['"][^'"]+['"]/g) || [];

      for (const call of indexCalls) {
        const indexMatch = call.match(/index:\s*['"]([^'"]+)['"]/);
        if (indexMatch) {
          expect(indexMatch[1]).toBe('vigil-reports');
        }
      }

      // No client.update() calls at all in reporter code
      expect(source).not.toMatch(/client\.update\(/);
    }
  });

  // ── Test 12: CLI flag parsing ─────────────────────────────────

  test('test_generate_cli_flags', async () => {
    const cliSource = await loadFile('scripts/reports/generate.js');

    // Verify all report types are valid
    expect(cliSource).toContain("'executive_summary'");
    expect(cliSource).toContain("'compliance_evidence'");
    expect(cliSource).toContain("'operational_trends'");
    expect(cliSource).toContain("'agent_performance'");
    expect(cliSource).toContain("'incident_detail'");

    // Verify flag parsing
    expect(cliSource).toContain("'--type'");
    expect(cliSource).toContain("'--window'");
    expect(cliSource).toContain("'--incident-id'");

    // Verify incident_detail requires --incident-id
    expect(cliSource).toContain('incident_detail');
    expect(cliSource).toContain('incidentId');

    // Verify window parsing supports d/h/m units
    expect(cliSource).toContain("case 'd'");
    expect(cliSource).toContain("case 'h'");
    expect(cliSource).toContain("case 'm'");
  });

  // ── Test 13: Report validation catches malformed reports ──────

  test('test_report_validation_rejects_malformed', async () => {
    const { validateReport } = await import('../../src/agents/reporter/narrative.js');

    // Missing required fields
    expect(() => validateReport({})).toThrow('Report validation failed');
    expect(() => validateReport({ report_id: 'test' })).toThrow();

    // Valid report passes
    expect(() => validateReport({
      report_id: 'RPT-TEST-2026-01-01-D001',
      report_type: 'executive_summary',
      sections: [{
        section_id: 'test', title: 'Test', narrative: 'Test',
        data: {}, source_query: 'FROM test'
      }],
      reporting_window: { start: '2026-01-01', end: '2026-01-02' },
      metadata: { methodology: 'Test' }
    })).not.toThrow();
  });

  // ── Test 14: Deadline helper rejects on timeout ───────────────

  test('test_deadline_helper_rejects_on_timeout', async () => {
    const { withDeadline } = await import('../../src/agents/reporter/narrative.js');

    await expect(
      withDeadline(() => new Promise(resolve => setTimeout(resolve, 5000)), { deadlineMs: 50 })
    ).rejects.toThrow('deadline exceeded');
  });
});
