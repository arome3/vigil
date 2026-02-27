import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('index-templates');

const templates = [
  {
    name: 'vigil-tmpl-alerts',
    index_patterns: ['vigil-alerts-*'],
    data_stream: {},
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.lifecycle.name': 'vigil-90d-policy'
      },
      mappings: {
        properties: {
          '@timestamp':          { type: 'date' },
          alert_id:              { type: 'keyword' },
          rule_id:               { type: 'keyword' },
          rule_name:             { type: 'text', fields: { keyword: { type: 'keyword' } } },
          severity_original:     { type: 'keyword' },
          source: {
            properties: {
              ip:                { type: 'ip' },
              geo: {
                properties: {
                  country_iso_code: { type: 'keyword' },
                  city_name:        { type: 'keyword' },
                  location:         { type: 'geo_point' }
                }
              },
              user_name:         { type: 'keyword' },
              user_domain:       { type: 'keyword' }
            }
          },
          destination: {
            properties: {
              ip:                { type: 'ip' },
              port:              { type: 'integer' }
            }
          },
          affected_asset: {
            properties: {
              id:                { type: 'keyword' },
              name:              { type: 'keyword' },
              criticality:       { type: 'keyword' }
            }
          },
          enrichment: {
            properties: {
              correlated_event_count:  { type: 'integer' },
              unique_destinations:     { type: 'integer' },
              failed_auth_count:       { type: 'integer' },
              priv_escalation_count:   { type: 'integer' },
              risk_signal:             { type: 'float' },
              historical_fp_rate:      { type: 'float' },
              asset_criticality_score: { type: 'float' }
            }
          },
          triage: {
            properties: {
              priority_score:      { type: 'float' },
              disposition:         { type: 'keyword' },
              suppression_reason:  { type: 'text' },
              triaged_at:          { type: 'date' },
              triaged_by:          { type: 'keyword' }
            }
          },
          incident_id:           { type: 'keyword' },
          raw_alert:             { type: 'flattened' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-alerts-operational',
    index_patterns: ['vigil-alerts-operational'],
    priority: 300,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          '@timestamp':              { type: 'date' },
          anomaly_id:                { type: 'keyword' },
          type:                      { type: 'keyword' },
          detected_at:               { type: 'date' },
          affected_service:          { type: 'keyword' },
          affected_service_tier:     { type: 'keyword' },
          anomaly_type:              { type: 'keyword' },
          metric_deviations:         { type: 'flattened' },
          root_cause_assessment:     { type: 'text' },
          root_cause_details: {
            properties: {
              is_root_cause:         { type: 'boolean' },
              confidence:            { type: 'keyword' },
              reasoning:             { type: 'text' },
              root_cause_service:    { type: 'keyword' }
            }
          },
          change_correlation: {
            properties: {
              deployment_found:      { type: 'boolean' },
              commit_sha:            { type: 'keyword' },
              commit_author:         { type: 'keyword' },
              commit_message:        { type: 'text' },
              pr_number:             { type: 'integer' },
              deployment_environment: { type: 'keyword' },
              time_gap_seconds:      { type: 'integer' },
              confidence:            { type: 'keyword' }
            }
          },
          affected_assets:           { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-incidents',
    index_patterns: ['vigil-incidents'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          incident_id:           { type: 'keyword' },
          status:                { type: 'keyword' },
          severity:              { type: 'keyword' },
          incident_type:         { type: 'keyword' },
          created_at:            { type: 'date' },
          updated_at:            { type: 'date' },
          resolved_at:           { type: 'date' },
          agents_involved:       { type: 'keyword' },
          alert_ids:             { type: 'keyword' },
          source_type:           { type: 'keyword' },
          investigation_summary: { type: 'text' },
          investigation_summary_vector: {
            type: 'dense_vector',
            dims: 1024,
            index: true,
            similarity: 'cosine',
            index_options: { type: 'int8_hnsw' }
          },
          affected_assets: {
            type: 'nested',
            properties: {
              asset_id:          { type: 'keyword' },
              name:              { type: 'keyword' },
              criticality:       { type: 'keyword' },
              confidence:        { type: 'float' }
            }
          },
          attack_chain:          { type: 'keyword' },
          change_correlation: {
            properties: {
              matched:           { type: 'boolean' },
              commit_sha:        { type: 'keyword' },
              commit_message:    { type: 'text' },
              commit_author:     { type: 'keyword' },
              pr_number:         { type: 'integer' },
              deployment_time:   { type: 'date' },
              time_gap_seconds:  { type: 'integer' },
              confidence:        { type: 'keyword' }
            }
          },
          remediation_plan: {
            properties: {
              actions: {
                type: 'nested',
                properties: {
                  order:             { type: 'integer' },
                  action_type:       { type: 'keyword' },
                  description:       { type: 'text' },
                  target_system:     { type: 'keyword' },
                  target_asset:      { type: 'keyword' },
                  approval_required: { type: 'boolean' },
                  rollback_steps:    { type: 'text' }
                }
              },
              success_criteria: {
                type: 'nested',
                properties: {
                  metric:            { type: 'keyword' },
                  operator:          { type: 'keyword' },
                  threshold:         { type: 'float' },
                  index_pattern:     { type: 'keyword' }
                }
              }
            }
          },
          verification_results: {
            type: 'nested',
            properties: {
              iteration:         { type: 'integer' },
              health_score:      { type: 'float' },
              passed:            { type: 'boolean' },
              failure_analysis:  { type: 'text' },
              failure_reason:    { type: 'text' },
              checked_at:        { type: 'date' },
              criteria_results: {
                type: 'nested',
                properties: {
                  metric:         { type: 'keyword' },
                  current_value:  { type: 'float' },
                  threshold:      { type: 'float' },
                  passed:         { type: 'boolean' }
                }
              }
            }
          },
          reflection_count:      { type: 'integer' },
          resolution_type:       { type: 'keyword' },
          ttd_seconds:           { type: 'integer' },
          tti_seconds:           { type: 'integer' },
          ttr_seconds:           { type: 'integer' },
          ttv_seconds:           { type: 'integer' },
          total_duration_seconds:{ type: 'integer' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-actions',
    index_patterns: ['vigil-actions-*'],
    data_stream: {},
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        'index.lifecycle.name': 'vigil-1y-policy'
      },
      mappings: {
        properties: {
          '@timestamp':            { type: 'date' },
          action_id:               { type: 'keyword' },
          incident_id:             { type: 'keyword' },
          agent_name:              { type: 'keyword' },
          action_type:             { type: 'keyword' },
          action_detail:           { type: 'text' },
          target_system:           { type: 'keyword' },
          target_asset:            { type: 'keyword' },
          approval_required:       { type: 'boolean' },
          approved_by:             { type: 'keyword' },
          approved_at:             { type: 'date' },
          execution_status:        { type: 'keyword' },
          started_at:              { type: 'date' },
          completed_at:            { type: 'date' },
          duration_ms:             { type: 'integer' },
          result_summary:          { type: 'text' },
          rollback_available:      { type: 'boolean' },
          error_message:           { type: 'text' },
          workflow_id:             { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-investigations',
    index_patterns: ['vigil-investigations'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          investigation_id:      { type: 'keyword' },
          incident_id:           { type: 'keyword' },
          iteration:             { type: 'integer' },
          created_at:            { type: 'date' },
          root_cause:            { type: 'text' },
          root_cause_vector: {
            type: 'dense_vector',
            dims: 1024,
            index: true,
            similarity: 'cosine',
            index_options: { type: 'int8_hnsw' }
          },
          attack_vector:         { type: 'keyword' },
          attack_chain: {
            type: 'nested',
            properties: {
              technique_id:      { type: 'keyword' },
              technique_name:    { type: 'text' },
              tactic:            { type: 'keyword' },
              evidence:          { type: 'text' }
            }
          },
          blast_radius: {
            type: 'nested',
            properties: {
              asset_id:          { type: 'keyword' },
              asset_name:        { type: 'keyword' },
              impact_type:       { type: 'keyword' },
              confidence:        { type: 'float' }
            }
          },
          threat_intel_matches: {
            type: 'nested',
            properties: {
              ioc_value:         { type: 'keyword' },
              ioc_type:          { type: 'keyword' },
              source:            { type: 'keyword' },
              threat_actor:      { type: 'keyword' },
              confidence:        { type: 'float' }
            }
          },
          change_correlation: {
            properties: {
              matched:           { type: 'boolean' },
              commit_sha:        { type: 'keyword' },
              commit_message:    { type: 'text' },
              commit_author:     { type: 'keyword' },
              pr_number:         { type: 'integer' },
              time_gap_seconds:  { type: 'integer' }
            }
          },
          similar_past_incidents: {
            type: 'nested',
            properties: {
              incident_id:       { type: 'keyword' },
              similarity_score:  { type: 'float' },
              resolution_strategy: { type: 'text' }
            }
          }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-runbooks',
    index_patterns: ['vigil-runbooks'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          runbook_id:            { type: 'keyword' },
          title:                 { type: 'text' },
          description:           { type: 'text' },
          content:               { type: 'text' },
          content_vector: {
            type: 'dense_vector',
            dims: 1024,
            index: true,
            similarity: 'cosine',
            index_options: { type: 'int8_hnsw' }
          },
          incident_types:        { type: 'keyword' },
          applicable_services:   { type: 'keyword' },
          severity_levels:       { type: 'keyword' },
          steps: {
            type: 'nested',
            properties: {
              order:             { type: 'integer' },
              action:            { type: 'text' },
              command:           { type: 'keyword' },
              target_system:     { type: 'keyword' },
              approval_required: { type: 'boolean' },
              rollback_command:  { type: 'keyword' }
            }
          },
          historical_success_rate: { type: 'float' },
          times_used:            { type: 'integer' },
          last_used_at:          { type: 'date' },
          tags:                  { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-assets',
    index_patterns: ['vigil-assets'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          asset_id:              { type: 'keyword' },
          name:                  { type: 'keyword' },
          type:                  { type: 'keyword' },
          criticality:           { type: 'keyword' },
          environment:           { type: 'keyword' },
          owner_team:            { type: 'keyword' },
          owner_email:           { type: 'keyword' },
          data_classification:   { type: 'keyword' },
          compliance_tags:       { type: 'keyword' },
          service_dependencies:  { type: 'keyword' },
          k8s_namespace:         { type: 'keyword' },
          k8s_deployment:        { type: 'keyword' },
          github_repo:           { type: 'keyword' },
          ip_addresses:          { type: 'ip' },
          last_updated:          { type: 'date' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-threat-intel',
    index_patterns: ['vigil-threat-intel'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          ioc_id:                { type: 'keyword' },
          type:                  { type: 'keyword' },
          value:                 { type: 'keyword' },
          threat_actor:          { type: 'keyword' },
          confidence:            { type: 'float' },
          source:                { type: 'keyword' },
          first_seen:            { type: 'date' },
          last_seen:             { type: 'date' },
          mitre_technique_id:    { type: 'keyword' },
          mitre_technique_name:  { type: 'text' },
          mitre_tactic:          { type: 'keyword' },
          description:           { type: 'text' },
          description_vector: {
            type: 'dense_vector',
            dims: 1024,
            index: true,
            similarity: 'cosine',
            index_options: { type: 'int8_hnsw' }
          },
          tags:                  { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-baselines',
    index_patterns: ['vigil-baselines'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          service_name:          { type: 'keyword' },
          metric_name:           { type: 'keyword' },
          window_start:          { type: 'date' },
          window_end:            { type: 'date' },
          avg_value:             { type: 'float' },
          stddev_value:          { type: 'float' },
          p50_value:             { type: 'float' },
          p95_value:             { type: 'float' },
          p99_value:             { type: 'float' },
          min_value:             { type: 'float' },
          max_value:             { type: 'float' },
          sample_count:          { type: 'integer' },
          computed_at:           { type: 'date' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-github-events',
    index_patterns: ['github-events-*'],
    data_stream: {},
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.lifecycle.name': 'vigil-90d-policy'
      },
      mappings: {
        properties: {
          '@timestamp':            { type: 'date' },
          event_id:                { type: 'keyword' },
          event_type:              { type: 'keyword' },
          repository:              { type: 'keyword' },
          branch:                  { type: 'keyword' },
          service_name:            { type: 'keyword' },
          commit: {
            properties: {
              sha:                 { type: 'keyword' },
              message:             { type: 'text' },
              author:              { type: 'keyword' },
              author_email:        { type: 'keyword' },
              timestamp:           { type: 'date' }
            }
          },
          pr: {
            properties: {
              number:              { type: 'integer' },
              title:               { type: 'text' },
              merged_by:           { type: 'keyword' }
            }
          },
          deployment: {
            properties: {
              environment:         { type: 'keyword' },
              status:              { type: 'keyword' },
              previous_sha:        { type: 'keyword' }
            }
          },
          files_changed:           { type: 'keyword' },
          additions:               { type: 'integer' },
          deletions:               { type: 'integer' }
        }
      }
    }
  },
  // ── New templates ────────────────────────────────────────────
  {
    name: 'vigil-tmpl-metrics',
    index_patterns: ['vigil-metrics-*'],
    data_stream: {},
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.lifecycle.name': 'vigil-90d-policy'
      },
      mappings: {
        properties: {
          '@timestamp':    { type: 'date' },
          service_name:    { type: 'keyword' },
          metric_name:     { type: 'keyword' },
          value:           { type: 'float' },
          unit:            { type: 'keyword' },
          source:          { type: 'keyword' },
          environment:     { type: 'keyword' },
          host:            { type: 'keyword' },
          tags:            { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-learnings',
    index_patterns: ['vigil-learnings'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.lifecycle.name': 'vigil-1y-policy'
      },
      mappings: {
        properties: {
          '@timestamp':           { type: 'date' },
          learning_id:            { type: 'keyword' },
          learning_type:          { type: 'keyword', doc_values: true },
          incident_ids:           { type: 'keyword' },
          analysis_window: {
            properties: {
              start:              { type: 'date' },
              end:                { type: 'date' },
              incident_count:     { type: 'integer' }
            }
          },
          summary:                { type: 'text', analyzer: 'standard' },
          summary_vector: {
            type: 'dense_vector',
            dims: 1024,
            similarity: 'cosine',
            index: true
          },
          confidence:             { type: 'float' },
          data:                   { type: 'flattened' },
          applied:                { type: 'boolean' },
          applied_at:             { type: 'date' },
          reviewed_by:            { type: 'keyword' },
          review_status:          { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-reports',
    index_patterns: ['vigil-reports'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.lifecycle.name': 'vigil-1y-policy'
      },
      mappings: {
        properties: {
          '@timestamp':           { type: 'date' },
          report_id:              { type: 'keyword' },
          report_type:            { type: 'keyword', doc_values: true },
          report_title:           { type: 'text', analyzer: 'standard' },
          reporting_window: {
            properties: {
              start:              { type: 'date' },
              end:                { type: 'date' }
            }
          },
          generated_at:           { type: 'date' },
          generated_by:           { type: 'keyword' },
          trigger_type:           { type: 'keyword' },
          sections: {
            type: 'nested',
            properties: {
              section_id:         { type: 'keyword' },
              title:              { type: 'text' },
              narrative:          { type: 'text', analyzer: 'standard' },
              narrative_vector: {
                type: 'dense_vector',
                dims: 1024,
                similarity: 'cosine',
                index: true
              },
              data:               { type: 'flattened' },
              source_query:       { type: 'text', index: false },
              compliance_controls: { type: 'keyword' }
            }
          },
          metadata: {
            properties: {
              incident_count:     { type: 'integer' },
              data_sources:       { type: 'keyword' },
              methodology:        { type: 'text', index: false },
              token_estimate:     { type: 'integer' }
            }
          },
          delivery: {
            properties: {
              channels:           { type: 'keyword' },
              delivered_at:       { type: 'date' },
              delivery_status:    { type: 'keyword' }
            }
          },
          status:                 { type: 'keyword' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-alert-claims',
    index_patterns: ['vigil-alert-claims'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          alert_id:              { type: 'keyword' },
          claimed_at:            { type: 'date' },
          processed_at:          { type: 'date' },
          error:                 { type: 'text' }
        }
      }
    }
  },
  {
    name: 'vigil-tmpl-agent-telemetry',
    index_patterns: ['vigil-agent-telemetry'],
    priority: 200,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1
      },
      mappings: {
        properties: {
          '@timestamp':        { type: 'date' },
          agent_name:          { type: 'keyword' },
          incident_id:         { type: 'keyword' },
          tool_name:           { type: 'keyword' },
          tool_type:           { type: 'keyword' },
          execution_time_ms:   { type: 'integer' },
          input_params:        { type: 'flattened' },
          result_count:        { type: 'integer' },
          status:              { type: 'keyword' },
          error_message:       { type: 'text' },
          llm_tokens_used:     { type: 'integer' }
        }
      }
    }
  }
];

async function run() {
  const info = await client.info();
  log.info(`Connected to Elasticsearch ${info.version.number}`);

  // Create/update all templates
  for (const { name, ...params } of templates) {
    await client.indices.putIndexTemplate({ name, ...params });
    log.info(`Created/updated index template: ${name}`);
  }
  log.info(`All ${templates.length} index templates created`);

  // Dry-run verification — simulate each template to catch composition errors
  log.info('Running dry-run template verification...');
  for (const { name } of templates) {
    const result = await client.indices.simulateIndexTemplate({ name });
    const mappingKeys = Object.keys(result.template?.mappings?.properties || {});
    log.info(`  ✓ ${name} — ${mappingKeys.length} mapped fields`);
  }
  log.info('All templates verified successfully');
}

run().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
