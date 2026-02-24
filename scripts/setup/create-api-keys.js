// Standalone API key provisioning script for Vigil agents.
//
// Creates scoped Elasticsearch API keys with least-privilege role descriptors
// for each of the 11 Vigil agents. Re-runnable: skips existing keys unless --rotate.
//
// Usage:
//   node scripts/setup/create-api-keys.js             # create missing keys
//   node scripts/setup/create-api-keys.js --rotate     # rotate all keys
//   node scripts/setup/create-api-keys.js --dry-run    # validate without creating

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import client from '../../src/utils/elastic-client.js';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('create-api-keys');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const dryRun = process.argv.includes('--dry-run');
const rotate = process.argv.includes('--rotate');

// ─── Agent list ──────────────────────────────────────────────────

const AGENT_NAMES = [
  'vigil-coordinator',
  'vigil-triage',
  'vigil-investigator',
  'vigil-threat-hunter',
  'vigil-sentinel',
  'vigil-commander',
  'vigil-executor',
  'vigil-verifier',
  'vigil-analyst',
  'vigil-reporter',
  'vigil-chat'
];

// ─── Hardened role descriptors (inline fallback) ─────────────────
// Least-privilege: separate read/write into distinct index entries.

const INLINE_ROLE_DESCRIPTORS = {
  'vigil-coordinator': {
    vigil_coordinator: {
      indices: [
        { names: ['vigil-alerts-*'], privileges: ['read'] },
        { names: ['vigil-incidents', 'vigil-actions-*'], privileges: ['read', 'write', 'create_index'] }
      ]
    }
  },
  'vigil-triage': {
    vigil_triage: {
      indices: [
        { names: ['logs-auth-*', 'vigil-assets', 'vigil-incidents'], privileges: ['read'] },
        { names: ['vigil-alerts-*'], privileges: ['read', 'write', 'create_index'] }
      ]
    }
  },
  'vigil-investigator': {
    vigil_investigator: {
      indices: [
        { names: ['vigil-alerts-*', 'vigil-threat-intel', 'vigil-incidents', 'github-events-*', 'logs-endpoint-*', 'logs-network-*', 'logs-dns-*', 'logs-auth-*'], privileges: ['read'] },
        { names: ['vigil-investigations'], privileges: ['read', 'write', 'create_index'] }
      ]
    }
  },
  'vigil-threat-hunter': {
    vigil_threat_hunter: {
      indices: [
        { names: ['logs-endpoint-*', 'logs-network-*', 'logs-dns-*', 'logs-auth-*', 'vigil-threat-intel'], privileges: ['read'] }
      ]
    }
  },
  'vigil-sentinel': {
    vigil_sentinel: {
      indices: [
        { names: ['vigil-baselines', 'vigil-assets', 'github-events-*', 'metrics-apm-*', 'metrics-system-*', 'logs-service-*'], privileges: ['read'] },
        { names: ['vigil-alerts-operational'], privileges: ['read', 'write'] }
      ]
    }
  },
  'vigil-commander': {
    vigil_commander: {
      indices: [
        { names: ['vigil-runbooks', 'vigil-assets', 'vigil-incidents', 'vigil-investigations'], privileges: ['read'] }
      ]
    }
  },
  'vigil-executor': {
    vigil_executor: {
      indices: [
        { names: ['vigil-incidents'], privileges: ['read'] },
        { names: ['vigil-actions-*'], privileges: ['read', 'write', 'create_index'] }
      ]
    }
  },
  'vigil-verifier': {
    vigil_verifier: {
      indices: [
        { names: ['vigil-baselines', 'vigil-actions-*', 'metrics-apm-*', 'metrics-system-*'], privileges: ['read'] },
        { names: ['vigil-incidents'], privileges: ['read', 'write'] }
      ]
    }
  },
  'vigil-analyst': {
    vigil_analyst: {
      indices: [
        { names: ['vigil-incidents', 'vigil-actions-*', 'vigil-baselines', 'vigil-runbooks', 'vigil-agent-telemetry'], privileges: ['read'] },
        { names: ['vigil-learnings', 'vigil-runbooks'], privileges: ['read', 'write', 'create_index'] }
      ]
    }
  },
  'vigil-reporter': {
    vigil_reporter: {
      indices: [
        { names: ['vigil-incidents', 'vigil-actions-*', 'vigil-learnings', 'vigil-agent-telemetry', 'vigil-investigations', 'vigil-runbooks', 'vigil-baselines', 'metrics-apm-*', 'metrics-system-*'], privileges: ['read'] },
        { names: ['vigil-reports'], privileges: ['read', 'write', 'create_index'] }
      ]
    }
  },
  'vigil-chat': {
    vigil_chat: {
      indices: [
        { names: ['vigil-incidents', 'vigil-agent-telemetry', 'vigil-actions-*', 'metrics-apm-*', 'metrics-system-*'], privileges: ['read'] }
      ]
    }
  }
};

// ─── External config loader ──────────────────────────────────────

function loadRoleDescriptors(agentName) {
  const shortName = agentName.replace(/^vigil-/, '');
  const candidates = [
    join(PROJECT_ROOT, 'src', 'agents', agentName, 'config.json'),
    join(PROJECT_ROOT, 'src', 'agents', shortName, 'config.json')
  ];

  const configPath = candidates.find(p => existsSync(p));
  if (!configPath) return null;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.api_key_role_descriptors) {
      log.info(`Loaded role descriptors for ${agentName} from ${configPath}`);
      return config.api_key_role_descriptors;
    }
  } catch (err) {
    log.warn(`Failed to load config for ${agentName}: ${err.message}`);
  }
  return null;
}

// ─── Key management ──────────────────────────────────────────────

async function getExistingKeys() {
  try {
    const resp = await client.security.getApiKey({ owner: false });
    const keyMap = new Map();
    for (const key of resp.api_keys || []) {
      if (key.name && key.name.startsWith('vigil-') && key.name.endsWith('-key') && !key.invalidated) {
        keyMap.set(key.name, key);
      }
    }
    return keyMap;
  } catch (err) {
    log.warn(`Could not fetch existing keys: ${err.message}. Will attempt creation for all.`);
    return new Map();
  }
}

async function invalidateKey(keyId, keyName) {
  try {
    await client.security.invalidateApiKey({ ids: [keyId] });
    log.info(`Invalidated old key: ${keyName} (${keyId})`);
  } catch (err) {
    log.warn(`Failed to invalidate key ${keyName}: ${err.message}`);
  }
}

async function createKey(agentName, roleDescriptors) {
  const keyName = `${agentName}-key`;
  const resp = await client.security.createApiKey({
    name: keyName,
    role_descriptors: roleDescriptors
  });
  return { id: resp.id, name: keyName, encoded: resp.encoded };
}

// ─── Main ────────────────────────────────────────────────────────

async function run() {
  log.info(`Vigil API Key Provisioner ${dryRun ? '(DRY RUN)' : ''} ${rotate ? '(ROTATE MODE)' : ''}`);

  const existing = await getExistingKeys();
  const summary = { created: 0, skipped: 0, rotated: 0, failed: 0 };

  for (const agentName of AGENT_NAMES) {
    const keyName = `${agentName}-key`;

    // Resolve role descriptors: external config takes priority
    const roleDescriptors = loadRoleDescriptors(agentName) || INLINE_ROLE_DESCRIPTORS[agentName];
    if (!roleDescriptors) {
      log.error(`No role descriptors found for ${agentName}`);
      summary.failed++;
      continue;
    }

    const existingKey = existing.get(keyName);

    // Skip if key exists and we're not rotating
    if (existingKey && !rotate) {
      log.info(`Key already exists: ${keyName} (id: ${existingKey.id}) — skipping`);
      summary.skipped++;
      continue;
    }

    if (dryRun) {
      const roleName = Object.keys(roleDescriptors)[0];
      const indices = roleDescriptors[roleName]?.indices?.map(i => i.names.join(', ')).join(' | ') || 'none';
      log.info(`[DRY RUN] Would create key: ${keyName} → role: ${roleName}, indices: [${indices}]`);
      summary.created++;
      continue;
    }

    try {
      // Rotate: invalidate old key first
      if (existingKey && rotate) {
        await invalidateKey(existingKey.id, keyName);
        summary.rotated++;
      }

      const key = await createKey(agentName, roleDescriptors);
      log.info(`Created API key: ${key.name} (id: ${key.id})`);
      // Only count as "created" for net-new keys; rotations already counted above
      if (!existingKey || !rotate) {
        summary.created++;
      }
    } catch (err) {
      log.error(`Failed to create key for ${agentName}: ${err.message}`);
      summary.failed++;
    }
  }

  // Summary
  log.info('─────────────────────────────────────────────');
  log.info(`API Key Summary: ${summary.created} created, ${summary.skipped} skipped, ${summary.rotated} rotated, ${summary.failed} failed`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

run().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
