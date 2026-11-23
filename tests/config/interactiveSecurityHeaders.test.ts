import { createHash } from "crypto";
import express from "express";
import request from "supertest";
import {
  buildInteractiveHelmetOptions,
  interactiveSecurityMiddleware,
} from "../../src/config/express";
import { renderSep24InteractivePage } from "../../src/services/sep24InteractivePage";
import { renderOrangeMoneyQrSection } from "../../src/providers/orange/qrCode";
import helmet from "helmet";

function buildApp(middleware = interactiveSecurityMiddleware) {
  const app = express();
  app.get("/sep24/interactive/deposit", middleware, (_req, res) => {
    res.type("html").send(
      renderSep24InteractivePage({
        qrSectionHtml: renderOrangeMoneyQrSection({
          dataUrl: "data:image/png;base64,AAAA",
          merchantId: "M-1",
          amount: "100",
          currency: "XOF",
        }),
      }),
    );
  });
  return app;
}

function parseCsp(header: string): Record<string, string[]> {
  return Object.fromEntries(
    header
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...values]) => [name, values]),
  );
}

function hashSource(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

describe("SEP-24 interactive view security headers", () => {
  const originalAncestors = process.env.SEP24_FRAME_ANCESTORS;

  afterEach(() => {
    if (originalAncestors === undefined) delete process.env.SEP24_FRAME_ANCESTORS;
    else process.env.SEP24_FRAME_ANCESTORS = originalAncestors;
  });

  it("sets the required security headers", async () => {
    const res = await request(buildApp()).get("/sep24/interactive/deposit");

    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["strict-transport-security"]).toContain("max-age=63072000");

    const csp = parseCsp(res.headers["content-security-policy"]);
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'self'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp["style-src"]).not.toContain("'unsafe-inline'");
  });

  it("allows every inline script and style block the page actually serves", async () => {
    const res = await request(buildApp()).get("/sep24/interactive/deposit");
    const csp = parseCsp(res.headers["content-security-policy"]);

    const scripts = Array.from(res.text.matchAll(/<script>([\s\S]*?)<\/script>/g));
    const styles = Array.from(res.text.matchAll(/<style>([\s\S]*?)<\/style>/g));
    expect(scripts.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);

    for (const [, body] of scripts) expect(csp["script-src"]).toContain(hashSource(body));
    for (const [, body] of styles) expect(csp["style-src"]).toContain(hashSource(body));

    // Inline attributes would be blocked by script-src-attr/style-src-attr 'none'.
    expect(res.text).not.toMatch(/\sstyle="/);
    expect(res.text).not.toMatch(/\son[a-z]+="/);
    // The embedded QR image is a data: URL, which img-src permits.
    expect(res.text).toContain('src="data:image/png;base64,');
    expect(csp["img-src"]).toContain("data:");
  });

  it("permits only approved https wallet origins as frame ancestors", async () => {
    process.env.SEP24_FRAME_ANCESTORS =
      "https://wallet.example.com, http://insecure.example.com, https://bad.example.com;script-src *";

    const middleware = helmet(buildInteractiveHelmetOptions());
    const res = await request(buildApp(middleware)).get("/sep24/interactive/deposit");
    const csp = parseCsp(res.headers["content-security-policy"]);

    expect(csp["frame-ancestors"]).toEqual(["'self'", "https://wallet.example.com"]);
  });
});
