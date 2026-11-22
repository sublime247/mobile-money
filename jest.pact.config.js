/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/tests/pact", "<rootDir>/tests/contracts"],
  testMatch: ["**/*.pact.test.ts", "**/*.contract.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { diagnostics: false }],
  },
  // https-proxy-agent is ESM-only and only used by the Verifier's proxy;
  // stub it so importing @pact-foundation/pact works under CJS jest.
  moduleNameMapper: {
    "^https-proxy-agent$": "<rootDir>/__mocks__/https-proxy-agent.js",
  },
  // Pact mock servers bind to ports — run serially to avoid conflicts
  maxWorkers: 1,
  testTimeout: 30000,
  verbose: true,
};

