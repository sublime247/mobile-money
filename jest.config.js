module.exports = {
  // Run two project configs in one pass:
  //   1. "backend"  — all existing TypeScript tests, node environment
  //   2. "frontend" — JS calculator tests, jsdom environment
  projects: [
    {
      displayName: "backend",
      preset: "ts-jest",
      testEnvironment: "node",
      setupFiles: ["<rootDir>/tests/jest.setup.ts"],
      roots: ["<rootDir>/src", "<rootDir>/tests"],
      testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
      // Exclude frontend JS, Playwright E2E, and Pact tests from backend Jest run
      testPathIgnorePatterns: [
        "/node_modules/",
        "<rootDir>/src/tests/frontend/",
        "<rootDir>/tests/e2e/",
        "<rootDir>/tests/pact/",
      ],
      transform: {
        "^.+\\.[jt]sx?$": ["ts-jest", { diagnostics: false }],
      },
      transformIgnorePatterns: [
        "node_modules/(?!(@stellar|@noble|@exodus|uint8array-extras)/)",
      ],
      moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
      // Mirrors the (otherwise-dead, since `projects` doesn't inherit
      // top-level options) mapper below — lets `jest.mock("../foo.js")`
      // resolve to the real "../foo.ts" source file.
      moduleNameMapper: {
        "^(\\.\\.?\\/.+)\\.js$": "$1",
      },
    },
    {
      displayName: "frontend",
      testEnvironment: "jsdom",
      setupFiles: ["<rootDir>/tests/jest.setup.ts"],
      roots: ["<rootDir>/src/tests/frontend"],
      testMatch: ["**/?(*.)+(spec|test).js"],
      transform: {
        "^.+\\.[jt]s$": ["ts-jest", { diagnostics: false }],
      },
      moduleFileExtensions: ["js", "ts", "json", "node"],
    },
  ],
  // Coverage collected from both projects
  preset: "ts-jest",
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: ["/node_modules/", "/tests/pact/", "/tests/e2e/"],
  testTimeout: 30000,
  moduleNameMapper: {
    "^(\\.\\.?\\/.+)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { diagnostics: false }],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "src/tests/frontend/**/*.js",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/__tests__/**",
    "!src/services/providerSettlementService.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "html", "json-summary"],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  verbose: true,
  maxWorkers: "50%",
};
