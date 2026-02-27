// Static configuration validation for the vigil-chat agent and its ES|QL + report tools.
// No mocking needed — reads JSON/MD files from disk and checks structural invariants.
// Run: NODE_OPTIONS='--experimental-vm-modules' npx jest tests/agents/chat/chat-agent.test.js

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const AGENT_DIR = join(PROJECT_ROOT, 'src', 'agents', 'chat');
const TOOLS_DIR = join(PROJECT_ROOT, 'src', 'tools', 'esql');

const CHAT_TOOL_FILES = [
  'vigil-chat-incident-lookup.json',
  'vigil-chat-incident-list.json',
  'vigil-chat-agent-activity.json',
  'vigil-chat-service-health.json',
  'vigil-chat-action-audit.json',
  'vigil-chat-triage-stats.json'
];

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
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

describe('vigil-chat agent configuration', () => {
  let config;

  beforeAll(() => {
    config = loadJson(join(AGENT_DIR, 'config.json'));
  });

  test('config.json is valid JSON with required fields', () => {
    expect(config.name).toBe('vigil-chat');
    expect(config.description).toBeTruthy();
    expect(config.model).toBeTruthy();
    expect(config.system_prompt_file).toBe('system-prompt.md');
    expect(Array.isArray(config.tools)).toBe(true);
    expect(config.tools).toHaveLength(8);
  });

  test('api_key_role_descriptors only contains read privileges', () => {
    const descriptors = config.api_key_role_descriptors;
    expect(descriptors).toBeTruthy();

    for (const [, roleDesc] of Object.entries(descriptors)) {
      for (const indexGrant of roleDesc.indices) {
        for (const privilege of indexGrant.privileges) {
          expect(privilege).toBe('read');
        }
      }
    }
  });

  test('a2a_connections is empty', () => {
    expect(config.a2a_connections).toEqual([]);
  });
});

describe('vigil-chat system prompt', () => {
  let prompt;

  beforeAll(() => {
    prompt = readFileSync(join(AGENT_DIR, 'system-prompt.md'), 'utf-8');
  });

  test('system-prompt.md contains read-only constraint', () => {
    expect(prompt.toLowerCase()).toContain('read-only');
    expect(prompt.toLowerCase()).toContain('cannot modify');
  });

  test('system-prompt.md is non-empty and substantive', () => {
    expect(prompt.trim().length).toBeGreaterThan(100);
  });
});

describe('vigil-chat ES|QL tool definitions', () => {
  const tools = {};

  beforeAll(() => {
    for (const file of CHAT_TOOL_FILES) {
      tools[file] = loadJson(join(TOOLS_DIR, file));
    }
  });

  test('all 6 tool files exist in src/tools/esql/', () => {
    const allFiles = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.json'));
    for (const toolFile of CHAT_TOOL_FILES) {
      expect(allFiles).toContain(toolFile);
    }
  });

  test.each(CHAT_TOOL_FILES)('%s has valid schema', (file) => {
    const tool = tools[file];
    expect(tool.id).toBeTruthy();
    expect(tool.type).toBe('esql');
    expect(tool.description).toBeTruthy();
    expect(tool.configuration).toBeTruthy();
    expect(tool.configuration.query).toBeTruthy();
    expect(tool.configuration.params).toBeTruthy();
  });

  test.each(CHAT_TOOL_FILES)('%s has matching query params and declared params', (file) => {
    const tool = tools[file];
    const queryParams = extractQueryParams(tool.configuration.query);
    const declaredParams = new Set(Object.keys(tool.configuration.params));

    // Every ?param in query must be declared
    for (const param of queryParams) {
      expect(declaredParams.has(param)).toBe(true);
    }

    // Every declared param must be referenced in query
    for (const param of declaredParams) {
      expect(queryParams.has(param)).toBe(true);
    }
  });

  test.each(CHAT_TOOL_FILES)('%s has id matching filename', (file) => {
    const tool = tools[file];
    const expectedId = file.replace('.json', '');
    expect(tool.id).toBe(expectedId);
  });

  test.each(CHAT_TOOL_FILES)('%s has chat tags and agent', (file) => {
    const tool = tools[file];
    expect(tool.tags).toContain('vigil');
    expect(tool.tags).toContain('chat');
    expect(tool.agent).toBe('vigil-chat');
  });
});

describe('provision-agents.js integration', () => {
  let provisionSource;

  beforeAll(() => {
    provisionSource = readFileSync(
      join(PROJECT_ROOT, 'scripts', 'setup', 'provision-agents.js'),
      'utf-8'
    );
  });

  test('includes vigil-chat in agents[] array', () => {
    expect(provisionSource).toContain("name: 'vigil-chat'");
  });

  test('has vigil-chat in apiKeyRoleDescriptors', () => {
    expect(provisionSource).toContain("'vigil-chat'");
    expect(provisionSource).toContain('vigil_chat');
  });

  test('vigil-chat role descriptors grant only read privileges', () => {
    // Extract the vigil-chat descriptor block (handles multi-line formatting)
    const chatStart = provisionSource.indexOf("'vigil-chat':");
    expect(chatStart).toBeGreaterThan(-1);

    const afterChat = provisionSource.slice(chatStart);
    // End at the next top-level descriptor key or closing brace
    const endMatch = afterChat.match(/\n\s{2}'vigil-|\n};/);
    const chatDescBlock = endMatch
      ? afterChat.slice(0, endMatch.index)
      : afterChat;

    expect(chatDescBlock).toContain('vigil_chat');
    expect(chatDescBlock).toContain("'read'");
    expect(chatDescBlock).not.toContain("'write'");
    expect(chatDescBlock).not.toContain("'create_index'");
  });
});
