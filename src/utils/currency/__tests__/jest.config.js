/**
 * Jest configuration for Currency Formatter Utility tests
 * Extends the main Jest configuration with specific settings for currency formatter testing
 */

const baseConfig = require("../../../../jest.config.js");

module.exports = {
  ...baseConfig,
  // Test files specific to currency formatter
  testMatch: [
    "<rootDir>/src/utils/currency/**/__tests__/**/*.test.ts",
    "<rootDir>/src/utils/currency/**/*.test.ts",
  ],
  // Coverage collection specific to currency formatter
  collectCoverageFrom: [
    "src/utils/currency/**/*.ts",
    "!src/utils/currency/**/*.d.ts",
    "!src/utils/currency/index.ts",
    "!src/utils/currency/**/__tests__/**",
    "!src/utils/currency/**/*.test.ts",
  ],
  // Higher coverage thresholds for currency formatter
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
    // Specific thresholds for each module
    "src/utils/currency/CurrencyFormatter.ts": {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
    "src/utils/currency/CurrencyConfig.ts": {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
    "src/utils/currency/ValidationEngine.ts": {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
    "src/utils/currency/FormatterCache.ts": {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
  // Display name for this test suite
  displayName: "Currency Formatter Utility",
  // Setup files specific to currency formatter tests
  setupFilesAfterEnv: ["<rootDir>/src/utils/currency/test-setup.ts"],
};
