/**
 * Jest configuration specifically for StrykerJS mutation testing.
 *
 * This is a STANDALONE config (does NOT extend jest.config.js) to prevent
 * the "projects" array from being inherited, which would spawn extra worker
 * processes and cause SIGBUS on Node v24 / macOS Apple Silicon.
 *
 * Key differences from the main jest.config.js:
 * - No `projects` array (avoids spawning extra workers)
 * - `isolatedModules: true` in ts-jest to disable the type-checker worker
 * - `maxWorkers: 1` to minimise concurrency inside Stryker's sandbox
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // setupFilesAfterEnv runs after Jest is initialised — required for jest.mock() in setup
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/src"],
  testMatch: [
    "<rootDir>/src/services/__tests__/transactionService.test.ts",
    "<rootDir>/src/services/__tests__/feeService.test.ts",
  ],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        // isolatedModules: true transpiles each file independently,
        // skipping full type-checking. This avoids spawning the ts-jest
        // type-checker worker that causes SIGBUS on Node v24 / macOS.
        isolatedModules: true,
        diagnostics: false,
        tsconfig: {
          // Use CommonJS modules so Jest can require() transformed files
          module: "CommonJS",
          target: "ES2022",
          esModuleInterop: true,
          allowJs: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  moduleNameMapper: {
    "^(\\.\\.?\\/.+)\\.js$": "$1",
  },
  maxWorkers: 1,
  testTimeout: 15000,
};
