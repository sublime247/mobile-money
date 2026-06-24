/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/tests/pact"],
  testMatch: ["**/*.pact.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { diagnostics: false }],
  },
  // Pact mock servers bind to ports — run serially to avoid conflicts
  maxWorkers: 1,
  testTimeout: 30000,
  verbose: true,
};
