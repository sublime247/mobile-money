/**
 * Integration test for security headers (issue 1976).
 * Verifies that helmet middleware correctly enforces:
 * - Strict-Transport-Security (HSTS) with max-age, includeSubDomains, and preload
 * - Content-Security-Policy (CSP) with strict directives
 * - X-Powered-By removal
 * - Other security headers (X-Frame-Options, X-Content-Type-Options, etc.)
 */
import express, { Express, Request, Response } from "express";
import request from "supertest";
import helmet from "helmet";
import {
  helmetOptions,
  permissionsPolicyMiddleware,
  reportToMiddleware,
} from "../src/config/express";

function buildSecurityApp(): Express {
  const app = express();

  // Apply helmet with the configured options
  app.use(helmet(helmetOptions));

  // Apply additional security middleware
  app.use(permissionsPolicyMiddleware);
  app.use(reportToMiddleware);

  // Test endpoint
  app.get("/test", (req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return app;
}

describe("Security Headers (Issue 1976)", () => {
  let app: Express;

  beforeAll(() => {
    app = buildSecurityApp();
  });

  describe("Strict-Transport-Security (HSTS)", () => {
    it("should set HSTS header with correct max-age", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["strict-transport-security"]).toBeDefined();
      expect(res.headers["strict-transport-security"]).toContain(
        "max-age=63072000",
      );
    });

    it("should include includeSubDomains in HSTS", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["strict-transport-security"]).toContain(
        "includeSubDomains",
      );
    });

    it("should include preload in HSTS", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["strict-transport-security"]).toContain("preload");
    });
  });

  describe("Content-Security-Policy (CSP)", () => {
    it("should set CSP header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["content-security-policy"]).toBeDefined();
    });

    it("should enforce default-src 'none' in CSP", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["content-security-policy"]).toContain(
        "default-src 'none'",
      );
    });

    it("should not allow unsafe-inline in CSP", async () => {
      const res = await request(app).get("/test");
      const csp = res.headers["content-security-policy"];
      expect(csp).not.toContain("unsafe-inline");
    });

    it("should not allow unsafe-eval in CSP", async () => {
      const res = await request(app).get("/test");
      const csp = res.headers["content-security-policy"];
      expect(csp).not.toContain("unsafe-eval");
    });

    it("should block frame ancestors in CSP", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
    });
  });

  describe("X-Powered-By Header", () => {
    it("should remove X-Powered-By header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });
  });

  describe("X-Frame-Options", () => {
    it("should set X-Frame-Options to DENY", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });
  });

  describe("X-Content-Type-Options", () => {
    it("should set X-Content-Type-Options to nosniff", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  describe("Referrer-Policy", () => {
    it("should set Referrer-Policy header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["referrer-policy"]).toBeDefined();
      expect(res.headers["referrer-policy"]).toBe(
        "strict-origin-when-cross-origin",
      );
    });
  });

  describe("Cross-Origin Policies", () => {
    it("should set Cross-Origin-Opener-Policy", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    });

    it("should set Cross-Origin-Resource-Policy", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    });

    it("should set Cross-Origin-Embedder-Policy", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    });
  });

  describe("Permissions-Policy", () => {
    it("should set Permissions-Policy header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["permissions-policy"]).toBeDefined();
    });

    it("should restrict sensitive APIs in Permissions-Policy", async () => {
      const res = await request(app).get("/test");
      const policy = res.headers["permissions-policy"];
      expect(policy).toContain("camera=()");
      expect(policy).toContain("microphone=()");
      expect(policy).toContain("geolocation=()");
    });
  });

  describe("DNS Prefetch Control", () => {
    it("should disable DNS prefetching", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    });
  });

  describe("HTTP Status Codes", () => {
    it("should return 200 OK for successful requests", async () => {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("should return 404 for non-existent endpoints", async () => {
      const res = await request(app).get("/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
