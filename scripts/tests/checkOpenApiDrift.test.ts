/**
 * scripts/tests/checkOpenApiDrift.test.ts (#2511)
 *
 * Automated tests for OpenAPI 3.1 specification drift detection in CI.
 * Scans Express application routes and verifies OpenAPI schema coverage.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.STELLAR_ISSUER_SECRET = "SDUHELR2QJTQH24GZKNCT5NBWJ2FCGMPRGKED5Y4REUZK4XCM73JMM4V";
process.env.KEY_VAULT_MASTER_SECRET = "test-key-vault-master-secret-32-chars-long";

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  scanExpressRoutes,
  normalizePathToOpenApi,
  checkOpenApiDrift,
} from "../generate-openapi-file";

test("normalizePathToOpenApi converts Express parameters to OpenAPI path templates", () => {
  assert.equal(
    normalizePathToOpenApi("/api/v1/transactions/:id"),
    "/api/v1/transactions/{id}",
  );
  assert.equal(
    normalizePathToOpenApi("/api/v1/vaults/:vaultId/transfer"),
    "/api/v1/vaults/{vaultId}/transfer",
  );
  assert.equal(
    normalizePathToOpenApi("/api/v1/users/:userId/documents/:docId/"),
    "/api/v1/users/{userId}/documents/{docId}",
  );
  assert.equal(normalizePathToOpenApi("/api/v1/prices/latest"), "/api/v1/prices/latest");
});

test("scanExpressRoutes extracts all registered routes and methods from Express app", () => {
  const app = express();
  const subRouter = express.Router();

  subRouter.get("/items", (_req, res) => res.json([]));
  subRouter.post("/items", (_req, res) => res.json({}));
  subRouter.get("/items/:itemId", (_req, res) => res.json({}));

  app.use("/api/v1", subRouter);
  app.delete("/api/v1/items/:itemId", (_req, res) => res.json({}));

  const routes = scanExpressRoutes(app);

  assert.equal(routes.length, 4);
  assert.ok(
    routes.some((r) => r.method === "GET" && r.path === "/api/v1/items"),
    "Should discover GET /api/v1/items",
  );
  assert.ok(
    routes.some((r) => r.method === "POST" && r.path === "/api/v1/items"),
    "Should discover POST /api/v1/items",
  );
  assert.ok(
    routes.some((r) => r.method === "GET" && r.path === "/api/v1/items/{itemId}"),
    "Should discover GET /api/v1/items/{itemId}",
  );
  assert.ok(
    routes.some((r) => r.method === "DELETE" && r.path === "/api/v1/items/{itemId}"),
    "Should discover DELETE /api/v1/items/{itemId}",
  );
});

test("checkOpenApiDrift detects undocumented routes when endpoints are missing from spec", () => {
  const app = express();
  app.get("/api/v1/users", (_req, res) => res.json([]));
  app.post("/api/v1/users", (_req, res) => res.json({}));
  app.get("/api/v1/undocumented", (_req, res) => res.json({}));

  const mockSpec = {
    paths: {
      "/api/v1/users": {
        get: { summary: "List users" },
        post: { summary: "Create user" },
      },
    },
  };

  const report = checkOpenApiDrift(app, mockSpec);

  assert.equal(report.isValid, false);
  assert.equal(report.undocumentedCount, 1);
  assert.equal(report.missingInOpenApi[0].method, "GET");
  assert.equal(report.missingInOpenApi[0].path, "/api/v1/undocumented");
});

test("checkOpenApiDrift passes when all routes match OpenAPI spec", () => {
  const app = express();
  app.get("/api/v1/transactions", (_req, res) => res.json([]));
  app.post("/api/v1/transactions/:id/simulate", (_req, res) => res.json({}));

  const mockSpec = {
    paths: {
      "/api/v1/transactions": {
        get: { summary: "List transactions" },
      },
      "/api/v1/transactions/{id}/simulate": {
        post: { summary: "Simulate transaction state" },
      },
    },
  };

  const report = checkOpenApiDrift(app, mockSpec);

  assert.equal(report.isValid, true);
  assert.equal(report.undocumentedCount, 0);
  assert.equal(report.missingInOpenApi.length, 0);
});

test("OpenAPI schema coverage verifies registered endpoints against live schema definitions", async () => {
  const { generateOpenAPIDocument } = await import("../../src/openapi/generator");
  const doc = generateOpenAPIDocument() as any;

  assert.ok(doc.paths, "OpenAPI document must contain paths object");
  assert.ok(Object.keys(doc.paths).length > 0, "OpenAPI document must have registered paths");

  // Verify key routes are documented
  assert.ok(doc.paths["/api/v1/transactions"], "Must document /api/v1/transactions");
  assert.ok(doc.paths["/api/v1/vaults"], "Must document /api/v1/vaults");
  assert.ok(doc.paths["/api/v1/prices/latest"], "Must document /api/v1/prices/latest");

  // Verify that an Express app with these documented routes has 0 drift
  const app = express();
  for (const p of Object.keys(doc.paths)) {
    const expressPath = p.replace(/\{([a-zA-Z0-9_]+)\}/g, ":$1");
    for (const m of Object.keys(doc.paths[p])) {
      if (typeof (app as any)[m] === "function") {
        (app as any)[m](expressPath, (_req: any, res: any) => res.json({}));
      }
    }
  }

  const report = checkOpenApiDrift(app, doc);
  assert.equal(report.isValid, true);
  assert.equal(report.undocumentedCount, 0);
});
