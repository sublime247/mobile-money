// @ts-check
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  // Apply to all TypeScript source files
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/**/__tests__/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: {
        // Node.js globals
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
        // Jest globals
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        jest: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // eslint:recommended equivalents
      "no-unused-vars": "off", // handled by @typescript-eslint version below
      "no-undef": "off", // TypeScript handles this
      "no-console": "off",
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-empty": "warn",
      "no-extra-semi": "error",
      "no-unreachable": "error",

      // @typescript-eslint/recommended rules
      ...tsPlugin.configs["flat/recommended"].rules,

      // Project-specific overrides (matching .eslintrc.json)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Test files — disable type-aware linting (tests excluded from tsconfig.json)
  {
    files: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/**/__tests__/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        // No "project" here — avoids parserOptions.project errors for test files
      },
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        jest: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Ignore patterns
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "jest.config.js",
      "**/*.js",
    ],
  },
];
