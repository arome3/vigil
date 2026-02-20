// Unit tests for the workflow secrets-manager module.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { validateWorkflowSecrets, getRequiredSecrets } = await import(
  '../../src/workflows/secrets-manager.js'
);

describe('secrets-manager', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('getRequiredSecrets', () => {
    test('returns 18 required secrets', () => {
      const secrets = getRequiredSecrets();
      expect(secrets).toHaveLength(18);
    });

    test('each secret has envVar, secretName, and usedBy fields', () => {
      const secrets = getRequiredSecrets();
      for (const secret of secrets) {
        expect(secret).toHaveProperty('envVar');
        expect(secret).toHaveProperty('secretName');
        expect(secret).toHaveProperty('usedBy');
        expect(typeof secret.envVar).toBe('string');
        expect(typeof secret.secretName).toBe('string');
        expect(typeof secret.usedBy).toBe('string');
      }
    });

    test('returns a frozen array (immutable)', () => {
      const secrets = getRequiredSecrets();
      expect(Object.isFrozen(secrets)).toBe(true);
    });
  });

  describe('validateWorkflowSecrets', () => {
    test('returns valid: true when all secrets are set', () => {
      const secrets = getRequiredSecrets();
      for (const s of secrets) {
        process.env[s.envVar] = 'test-value';
      }

      const result = validateWorkflowSecrets();
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    test('returns valid: false with missing secrets listed', () => {
      // Clear all relevant env vars
      const secrets = getRequiredSecrets();
      for (const s of secrets) {
        delete process.env[s.envVar];
      }

      const result = validateWorkflowSecrets();
      expect(result.valid).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.missing).toContain('SLACK_BOT_TOKEN');
      expect(result.missing).toContain('KIBANA_URL');
    });

    test('treats empty string values as missing', () => {
      const secrets = getRequiredSecrets();
      for (const s of secrets) {
        process.env[s.envVar] = 'valid';
      }
      process.env.SLACK_BOT_TOKEN = '';
      process.env.JIRA_BASE_URL = '   ';

      const result = validateWorkflowSecrets();
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('SLACK_BOT_TOKEN');
      expect(result.missing).toContain('JIRA_BASE_URL');
    });

    test('never throws', () => {
      // Clear everything
      const secrets = getRequiredSecrets();
      for (const s of secrets) {
        delete process.env[s.envVar];
      }

      expect(() => validateWorkflowSecrets()).not.toThrow();
    });
  });
});
