/**
 * Standalone Jest configuration for Stryker queue worker mutation testing.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: [
    "<rootDir>/src/tests/queue/syncWorker.test.ts",
    "<rootDir>/src/tests/queue/syncQueue.retention.test.ts",
    "<rootDir>/src/tests/queue/syncWorker.nats.test.ts",
    "<rootDir>/src/tests/queue/syncQueue.test.ts",
  ],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        isolatedModules: true,
        diagnostics: false,
        tsconfig: {
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
