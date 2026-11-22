import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("OpenAPI 3.1 YAML specification exists and conforms to schema requirements", () => {
  const openApiPath = path.resolve(__dirname, "../docs/openapi.yaml");
  assert.ok(fs.existsSync(openApiPath), "docs/openapi.yaml must exist");

  const yamlContent = fs.readFileSync(openApiPath, "utf-8");
  assert.ok(yamlContent.includes("openapi: 3.1.0"), "Spec must be OpenAPI 3.1.0");
  assert.ok(yamlContent.includes("title: Mobile Money Stellar Bridge API"), "Title must be set");
  assert.ok(yamlContent.includes("/api/auth/sep10/challenge"), "Must document SEP-10 challenge");
  assert.ok(yamlContent.includes("/api/auth/sep10/token"), "Must document SEP-10 token exchange");
  assert.ok(yamlContent.includes("/sep12/customer"), "Must document SEP-12 KYC");
  assert.ok(yamlContent.includes("/sep24/transactions/deposit/interactive"), "Must document SEP-24 deposits");
  assert.ok(yamlContent.includes("/sep38/quote"), "Must document SEP-38 quotes");
  assert.ok(yamlContent.includes("BearerAuth:"), "Must document BearerAuth security scheme");

  // Validate sandbox server URL using exact URL object parsing to satisfy CodeQL URL sanitization
  const allUrls = yamlContent
    .split("\n")
    .filter((line) => line.trim().startsWith("- url:"))
    .map((line) => line.replace(/^.*- url:\s*/, "").trim());

  const hasSandbox = allUrls.some((rawUrl) => {
    try {
      const u = new URL(rawUrl);
      return u.hostname === "sandbox.bridge.stellarwave.io";
    } catch {
      return false;
    }
  });
  assert.equal(hasSandbox, true, "Must document Try it Out sandbox server");
});

test("Swagger UI docs route and sandbox mode are configured in Express app", () => {
  const docsRoutePath = path.resolve(__dirname, "../src/routes/docs.ts");
  const appPath = path.resolve(__dirname, "../src/app.ts");
  const indexPath = path.resolve(__dirname, "../src/index.ts");

  assert.ok(fs.existsSync(docsRoutePath), "src/routes/docs.ts must exist");
  assert.ok(fs.existsSync(appPath), "src/app.ts must exist");

  const docsContent = fs.readFileSync(docsRoutePath, "utf-8");
  assert.ok(docsContent.includes("swaggerUi"), "Must use swaggerUi");
  assert.ok(docsContent.includes("docsRateLimiter"), "Must use rate limiting on docs routes");
  assert.ok(docsContent.includes("/openapi.yaml"), "Must expose /openapi.yaml");
  assert.ok(docsContent.includes("/openapi.json"), "Must expose /openapi.json");
  assert.ok(docsContent.includes("/sandbox/"), "Must support sandbox mode mock responses");
  assert.ok(docsContent.includes("tryItOutEnabled: true"), "Must enable tryItOut mode");

  const indexContent = fs.readFileSync(indexPath, "utf-8");
  assert.ok(indexContent.includes('app.use("/api/docs", docsRouter)'), "index.ts must mount /api/docs");

  const appContent = fs.readFileSync(appPath, "utf-8");
  assert.ok(appContent.includes('app.use("/api/docs", docsRouter)'), "app.ts must serve /api/docs");
});
