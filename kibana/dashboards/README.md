# Vigil Kibana Dashboards

Two Kibana dashboards for real-time SOC visibility during demos and production.

## Dashboards

| Dashboard | ID | Panels | Purpose |
|-----------|-----|--------|---------|
| **Command Center** | `vigil-dash-command-center` | 10 | Primary overview — active incidents, MTTR, agent activity, service health, triage metrics |
| **Incident Detail** | `vigil-dash-incident-detail` | 7 | Drilldown by `incident_id` — metadata, agent timeline, attack chain, remediation, verification, audit log |

## Prerequisites

- **Kibana 8.17+** and **Elasticsearch 8.17+** (ES|QL nested field access requires 8.14+, color mappings require 8.11+, metric palettes require 8.12+)
- Populated Vigil indices (`vigil-incidents`, `vigil-alerts-*`, `vigil-actions-*`, `vigil-investigations`)
- `KIBANA_URL` and `ELASTIC_API_KEY` environment variables set
- Service Health panel requires APM data (`metrics-apm-*`) — deploy Elastic APM agents or accept an empty panel

## Quick Import

### Option A: Import Script (Recommended)

```bash
./scripts/import-dashboards.sh
```

The script reads `KIBANA_URL` and `ELASTIC_API_KEY` from `.env` or the environment, imports all saved objects with `overwrite=true`, and prints dashboard URLs on success.

### Option B: Manual curl

```bash
curl -X POST "${KIBANA_URL}/api/saved_objects/_import?overwrite=true" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${ELASTIC_API_KEY}" \
  --form file=@kibana/dashboards/vigil-dashboards.ndjson
```

### Option C: Kibana UI

1. Open **Kibana > Stack Management > Saved Objects**
2. Click **Import**
3. Select `kibana/dashboards/vigil-dashboards.ndjson`
4. Choose **Overwrite** for existing objects
5. Click **Import**

## Dashboard Reference

### Command Center Layout (48-column grid)

```
Row 1 (y=0,  h=8):   [Active Incidents w=12] [MTTR w=12] [Suppressed w=12] [Reflections w=12]
Row 2 (y=8,  h=15):  [Incident Timeline w=24]            [Agent Activity w=24]
Row 3 (y=23, h=15):  [Service Health w=24]               [Change Correlation w=24]
Row 4 (y=38, h=15):  [Triage Distribution w=24]          [Top Affected Assets w=24]
```

| Panel | ID | Type | Data Source |
|-------|----|------|-------------|
| Active Incidents | `vigil-viz-cc-active-incidents` | Metric | `vigil-incidents` |
| MTTR (Last 24h) | `vigil-viz-cc-mttr` | Metric | `vigil-incidents` |
| Suppressed Today | `vigil-viz-cc-suppressed` | Metric | `vigil-alerts-*` |
| Reflections | `vigil-viz-cc-reflections` | Metric | `vigil-incidents` |
| Incident Timeline | `vigil-viz-cc-incident-timeline` | Bar (stacked) | `vigil-incidents` |
| Agent Activity | `vigil-viz-cc-agent-activity` | Data table | `vigil-actions-*` |
| Service Health | `vigil-viz-cc-service-health` | Data table | `metrics-apm-*` |
| Change Correlation | `vigil-viz-cc-change-correlation` | Data table | `vigil-investigations` |
| Triage Distribution | `vigil-viz-cc-triage-dist` | Pie chart | `vigil-alerts-*` |
| Top Affected Assets | `vigil-viz-cc-top-assets` | Bar (horizontal) | `vigil-incidents` |

### Incident Detail Layout (all panels full-width)

| Panel | ID | Type | Data Source |
|-------|----|------|-------------|
| Metadata | `vigil-viz-id-metadata` | Data table | `vigil-incidents` |
| Agent Timeline | `vigil-viz-id-agent-timeline` | Data table | `vigil-actions-*` |
| Attack Chain | `vigil-viz-id-attack-chain` | Data table | `vigil-investigations` |
| Change Correlation | `vigil-viz-id-change-correlation` | Data table | `vigil-investigations` |
| Remediation Plan | `vigil-viz-id-remediation` | Data table | `vigil-incidents` |
| Verification Results | `vigil-viz-id-verification` | Data table | `vigil-incidents` |
| Audit Log | `vigil-viz-id-audit-log` | Data table | `vigil-actions-*` |

## Post-Import Setup

### 1. Incident ID Control (Incident Detail Dashboard)

The dashboard includes a pre-configured `optionsListControl` for `incident_id`. After import, verify it appears in the control bar. If not:

1. Open the Incident Detail dashboard in edit mode
2. Click **Controls** in the toolbar
3. Add an **Options list** control on the `incident_id` field from `vigil-incidents`
4. Set **Single select** to `true`

### 2. Drilldown Navigation

Drilldowns from Command Center to Incident Detail are pre-configured on:
- **Incident Timeline** panel (click a bar to drill into that incident)
- **Change Correlation** panel (click a row to drill into the correlated incident)

If drilldowns don't work after import, re-create them:
1. Edit the Command Center dashboard
2. Select the Incident Timeline panel > **Create drilldown**
3. Choose **Go to dashboard** > **Vigil Incident Detail**
4. Map `incident_id` from the clicked data point
5. Repeat for the Change Correlation panel

### 3. Refresh Interval

The Command Center auto-refreshes every **5 seconds** (pre-configured). The Incident Detail dashboard has a **60-second** refresh (paused by default). To adjust:
1. Open the dashboard
2. Click the time picker > **Refresh every** > choose interval

## Customization

All panels use ES|QL queries stored in the Lens visualization state. To modify a query:

1. Open the dashboard in edit mode
2. Click the panel's gear icon > **Edit lens**
3. Modify the ES|QL query in the query bar
4. Save the visualization

## Export

To export dashboards after customization:

```bash
curl -X POST "${KIBANA_URL}/api/saved_objects/_export" \
  -H "kbn-xsrf: true" \
  -H "Authorization: ApiKey ${ELASTIC_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "objects": [
      { "type": "dashboard", "id": "vigil-dash-command-center" },
      { "type": "dashboard", "id": "vigil-dash-incident-detail" }
    ],
    "includeReferencesDeep": true
  }' > kibana/dashboards/vigil-dashboards.ndjson
```

## Known Limitations

These are Kibana Lens platform limitations that cannot be resolved via saved objects:

| Limitation | Reason | Workaround |
|-----------|--------|------------|
| No cell coloring by `execution_status` string | Lens datatable `colorMode` only supports numeric ranges, not categorical strings | Apply manual color rules in Kibana UI post-import |
| No conditional panel visibility | Lens panels cannot conditionally hide based on data values | Hide panels manually or use separate dashboards |
| No duration bars in datatable cells | Lens datatables don't support inline visualizations (sparklines, bars) | Use `duration_ms` numeric column; compare via sorting |
| CSV export not persisted | Per-session Kibana UI setting | Click export icon in the audit log panel toolbar |
| Service Health empty without APM | Panel queries `metrics-apm-*` which requires deployed APM agents | Deploy Elastic APM agents or accept empty panel in demos |

## Post-Import Formatting

Some visual tuning must be done in the Kibana UI after import:

- **Row highlighting by severity/status**: Lens datatables don't support row-level conditional formatting via saved objects. Use Kibana's color rules UI on numeric columns.
- **Nested field queries**: Panels D.3 (Attack Chain), D.5 (Remediation Plan), and D.6 (Verification Results) use ES|QL nested dot notation. This requires ES|QL 8.14+ — verify your Elasticsearch version if these panels show errors.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Index not found" errors | Run `./scripts/bootstrap.sh` to create Vigil indices |
| Empty panels | Run a demo scenario to populate data: `node scripts/demo/scenario-1-compromised-key.js` |
| Service Health panel empty | Requires Elastic APM agents on monitored services (`metrics-apm-*` data) |
| Import returns 413 | Increase Kibana's `server.maxPayload` setting |
| Import returns 401 | Verify `ELASTIC_API_KEY` has Kibana access permissions |
| Drilldowns not working | Re-create manually (see Post-Import Setup section above) |
| Controls not filtering | Ensure the `incident_id` field exists in `vigil-incidents` index |
