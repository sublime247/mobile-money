import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "miniflare",
    environmentOptions: {
      modules: true,
      scriptPath: "src/index.ts",
    },
  },
});
