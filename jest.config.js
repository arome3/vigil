// Jest configuration for ESM modules.
// Run with: NODE_OPTIONS='--experimental-vm-modules' npx jest
//
// Unit tests under tests/unit/ use node:test and are excluded here.
// Run them separately via: node --test 'tests/unit/**/*.test.js'

export default {
  transform: {},
  testPathIgnorePatterns: ['tests/unit/'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/index.js'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75
    }
  },
  projects: [
    {
      displayName: 'agents',
      transform: {},
      testMatch: [
        '<rootDir>/tests/agents/**/*.test.js',
        '<rootDir>/tests/agent/**/*.test.js'
      ],
      testPathIgnorePatterns: ['tests/unit/'],
      testTimeout: 15000
    },
    {
      displayName: 'integration',
      transform: {},
      testMatch: [
        '<rootDir>/tests/integration/**/*.test.js'
      ],
      testPathIgnorePatterns: ['tests/unit/'],
      testTimeout: 30000
    },
    {
      displayName: 'framework',
      transform: {},
      testMatch: [
        '<rootDir>/tests/tools/**/*.test.js',
        '<rootDir>/tests/workflows/**/*.test.js',
        '<rootDir>/tests/webhook-server/**/*.test.js',
        '<rootDir>/tests/reporter/**/*.test.js'
      ],
      testPathIgnorePatterns: [
        'tests/unit/',
        // vector-search uses node:test API and requires live Elasticsearch;
        // run it via: node --test tests/tools/vector-search.test.js
        'tests/tools/vector-search\\.test\\.js'
      ],
      testTimeout: 10000
    }
  ]
};
