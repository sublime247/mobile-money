import { runSecurityScan } from "../../../scripts/security-scan";
import { maskPII } from "../../utils/masking";
import { redact, REDACTED } from "../../utils/redact";
import { createHmac } from "crypto";
import { verifyMtnCallbackSignature } from "../../middleware/mtnCallbackSignature";
import { errorHandler } from "../../middleware/errorHandler";
import { getConfigValue } from "../../config/appConfig";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { execSync } from "child_process";
import { buildCspDirectives } from "../../config/express";
import { applySecurityMiddleware } from "../../config/express";

jest.mock("child_process", () => ({
  execSync: jest.fn(),
}));

jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.mtn.callbackSecret") return "test-secret-key-12345";
    if (key === "providers.mtn.callbackSignatureHeader")
      return "x-callback-signature";
    return undefined;
  }),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe("Security Scanning Tools & Pipeline Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getConfigValue as jest.Mock).mockImplementation((key: string) => {
      if (key === "providers.mtn.callbackSecret")
        return "test-secret-key-12345";
      if (key === "providers.mtn.callbackSignatureHeader")
        return "x-callback-signature";
      return undefined;
    });

    mockExecSync.mockReturnValue(
      JSON.stringify({
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        },
      }),
    );
  });

  it("applies the required Helmet security headers to application routes", async () => {
    const app = express();
    applySecurityMiddleware(app);
    app.get("/headers-check", (_req, res) => res.sendStatus(200));

    const response = await request(app).get("/headers-check").expect(200);

    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["strict-transport-security"]).toContain("preload");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  describe("CSP frame source configuration", () => {
    const originalFrameSrc = process.env.CSP_FRAME_SRC;
    const originalInteractiveUrl = process.env.SEP24_INTERACTIVE_URL;

    afterEach(() => {
      if (originalFrameSrc === undefined) delete process.env.CSP_FRAME_SRC;
      else process.env.CSP_FRAME_SRC = originalFrameSrc;
      if (originalInteractiveUrl === undefined)
        delete process.env.SEP24_INTERACTIVE_URL;
      else process.env.SEP24_INTERACTIVE_URL = originalInteractiveUrl;
    });

    it("allows exact configured SEP-24 and WebAuth origins", () => {
      process.env.CSP_FRAME_SRC = "https://wallet.example.com";
      process.env.SEP24_INTERACTIVE_URL = "https://anchor.example.com/sep24";

      const directives = buildCspDirectives();

      expect(directives.frameSrc).toEqual([
        "'self'",
        "https://wallet.example.com",
        "https://api.mobilemoney.com",
        "https://anchor.example.com",
      ]);
      expect(directives.frameAncestors).toEqual(["'none'"]);
    });

    it("rejects wildcard frame origins", () => {
      process.env.CSP_FRAME_SRC = "https://*.example.com";

      expect(() => buildCspDirectives()).toThrow(
        "CSP frame sources must be exact origins",
      );
    });
  });

  describe("1. Security Scanner Tool Execution", () => {
    it("runs security scanner and returns structured security check results", async () => {
      const scanOutput = await runSecurityScan();
      expect(scanOutput).toHaveProperty("passed");
      expect(scanOutput).toHaveProperty("results");
      expect(Array.isArray(scanOutput.results)).toBe(true);

      const checkNames = scanOutput.results.map((r) => r.name);
      expect(checkNames).toContain("Gitignore Security Baseline");
      expect(checkNames).toContain("Security Middleware & Dependencies");
      expect(checkNames).toContain("NPM Dependency Vulnerability Audit");

      for (const item of scanOutput.results) {
        expect(["pass", "warn", "fail"]).toContain(item.status);
        expect(["dependency", "secret", "config", "headers"]).toContain(
          item.category,
        );
        expect(typeof item.message).toBe("string");
      }
    });

    it("handles npm audit reporting vulnerabilities correctly", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({
          metadata: {
            vulnerabilities: {
              info: 0,
              low: 2,
              moderate: 1,
              high: 1,
              critical: 0,
              total: 4,
            },
          },
        }),
      );

      const scanOutput = await runSecurityScan();
      const auditResult = scanOutput.results.find((r) =>
        r.name.includes("NPM Dependency Vulnerability Audit"),
      );

      expect(auditResult).toBeDefined();
      expect(auditResult?.status).toBe("warn");
      expect(auditResult?.message).toContain("High: 1");
    });
  });

  describe("2. Sensitive Data Redaction and PII Masking Routines", () => {
    it("masks sensitive phone numbers, api keys, and tokens in log outputs", () => {
      const sensitiveData = {
        phoneNumber: "+237670000001",
        apiKey: "sec_live_99887766554433221100",
        amount: "5000",
        email: "user@example.com",
      };

      const masked = maskPII(sensitiveData);
      expect(masked.phoneNumber).not.toBe("+237670000001");
      expect(masked.phoneNumber).toContain("***");
    });

    it("redacts credentials from object structures and raw request headers", () => {
      const headers = {
        authorization: "Bearer secret-jwt-token-123",
        "x-api-key": "super-secret-key",
        "content-type": "application/json",
      };

      const redacted = redact(headers) as Record<string, string>;
      expect(redacted.authorization).toBe(REDACTED);
      expect(redacted["x-api-key"]).toBe(REDACTED);
      expect(redacted["content-type"]).toBe("application/json");
    });
  });

  describe("3. Webhook HMAC Cryptographic Signature Verification", () => {
    let app: express.Application;

    beforeEach(() => {
      process.env.MTN_CALLBACK_SECRET = "test-secret-key-12345";
      app = express();
      app.use(
        express.json({
          verify: (req, _res, buf) => {
            (req as any).rawBody = buf;
          },
        }),
      );
      app.use(
        rateLimit({
          windowMs: 60 * 1000,
          max: 100,
          standardHeaders: true,
          legacyHeaders: false,
        }),
      );
      app.use(verifyMtnCallbackSignature);
      app.post("/test-secure-webhook", (_req, res) => {
        res.status(200).json({ status: "verified" });
      });
      app.use(errorHandler);
    });

    it("accepts requests with a cryptographically valid HMAC-SHA256 signature", async () => {
      const payload = { event: "payout_update", id: "12345" };
      const rawString = JSON.stringify(payload);
      const signature = createHmac("sha256", "test-secret-key-12345")
        .update(rawString)
        .digest("hex");

      const res = await request(app)
        .post("/test-secure-webhook")
        .set("X-Callback-Signature", signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "verified" });
    });

    it("blocks requests with forged or invalid HMAC signatures", async () => {
      const payload = { event: "payout_update", id: "12345" };

      const res = await request(app)
        .post("/test-secure-webhook")
        .set("X-Callback-Signature", "forged-base64-signature")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized callback");
    });
  });
});
