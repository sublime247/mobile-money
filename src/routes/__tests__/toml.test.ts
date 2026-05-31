import request from "supertest";
import express, { Express } from "express";
import tomlRouter, { generateToml } from "../toml";

// ============================================================================
// Helpers
// ============================================================================

function makeApp(): Express {
  const app = express();
  app.use("/.well-known/stellar.toml", tomlRouter);
  return app;
}

// Save and restore env vars around each test
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Sensible defaults for all tests
  process.env.STELLAR_NETWORK = "testnet";
  process.env.STELLAR_ASSET_CODE = "USDC";
  process.env.STELLAR_ASSET_ISSUER =
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  process.env.STELLAR_WEB_AUTH_DOMAIN = "mobilemoney.com";
  delete process.env.STELLAR_FEDERATION_SERVER_URL;
  delete process.env.STELLAR_FEDERATION_SERVER;
  delete process.env.STELLAR_SIGNING_KEY;
  delete process.env.STELLAR_EXTRA_ASSETS;
  delete process.env.ORG_NAME;
});

afterEach(() => {
  process.env = savedEnv;
});

// ============================================================================
// HTTP endpoint
// ============================================================================

describe("GET /.well-known/stellar.toml", () => {
  it("returns 200 with text/plain content-type", async () => {
    const res = await request(makeApp()).get("/.well-known/stellar.toml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("sets Access-Control-Allow-Origin: *", async () => {
    const res = await request(makeApp()).get("/.well-known/stellar.toml");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("sets ETag header", async () => {
    const res = await request(makeApp()).get("/.well-known/stellar.toml");
    expect(res.headers["etag"]).toBeDefined();
    expect(res.headers["etag"]).toMatch(/^"[a-f0-9]+"$/);
  });

  it("sets Cache-Control: no-cache", async () => {
    const res = await request(makeApp()).get("/.well-known/stellar.toml");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches ETag", async () => {
    const app = makeApp();
    const first = await request(app).get("/.well-known/stellar.toml");
    const etag = first.headers["etag"];

    const second = await request(app)
      .get("/.well-known/stellar.toml")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("returns 200 when If-None-Match is stale", async () => {
    const res = await request(makeApp())
      .get("/.well-known/stellar.toml")
      .set("If-None-Match", '"stale-etag-value"');

    expect(res.status).toBe(200);
  });

  it("returns different ETag after env config change", async () => {
    const app = makeApp();
    const before = await request(app).get("/.well-known/stellar.toml");

    // Change config between requests
    process.env.STELLAR_SIGNING_KEY =
      "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRS";

    const after = await request(app).get("/.well-known/stellar.toml");

    expect(before.headers["etag"]).not.toBe(after.headers["etag"]);
  });
});

// ============================================================================
// generateToml — content correctness
// ============================================================================

describe("generateToml()", () => {
  describe("General section", () => {
    it("includes testnet NETWORK_PASSPHRASE for testnet", () => {
      process.env.STELLAR_NETWORK = "testnet";
      const toml = generateToml();
      expect(toml).toContain("Test SDF Network");
    });

    it("includes mainnet NETWORK_PASSPHRASE for mainnet", () => {
      process.env.STELLAR_NETWORK = "mainnet";
      const toml = generateToml();
      expect(toml).toContain("Public Global Stellar Network");
    });

    it("includes FEDERATION_SERVER line", () => {
      const toml = generateToml();
      expect(toml).toMatch(/FEDERATION_SERVER=/);
    });

    it("uses STELLAR_FEDERATION_SERVER env var when set", () => {
      process.env.STELLAR_FEDERATION_SERVER = "https://custom.example.com/fed";
      const toml = generateToml();
      expect(toml).toContain("https://custom.example.com/fed");
    });

    it("includes TRANSFER_SERVER_SEP0024 line", () => {
      const toml = generateToml();
      expect(toml).toMatch(/TRANSFER_SERVER_SEP0024=/);
    });

    it("includes KYC_SERVER line", () => {
      const toml = generateToml();
      expect(toml).toMatch(/KYC_SERVER=/);
    });

    it("includes DIRECT_PAYMENT_SERVER line", () => {
      const toml = generateToml();
      expect(toml).toMatch(/DIRECT_PAYMENT_SERVER=/);
    });

    it("includes SIGNING_KEY when set", () => {
      process.env.STELLAR_SIGNING_KEY = "GABCDEFG";
      const toml = generateToml();
      expect(toml).toContain("SIGNING_KEY=");
      expect(toml).toContain("GABCDEFG");
    });

    it("omits SIGNING_KEY when not set", () => {
      delete process.env.STELLAR_SIGNING_KEY;
      delete process.env.STELLAR_ISSUER_ACCOUNT;
      const toml = generateToml();
      expect(toml).not.toMatch(/^SIGNING_KEY=/m);
    });
  });

  describe("CURRENCIES section", () => {
    it("always includes native XLM entry", () => {
      const toml = generateToml();
      const xlmSection = toml
        .split("[[CURRENCIES]]")
        .find((s) => s.includes('code="XLM"'));
      expect(xlmSection).toBeDefined();
    });

    it("includes configured USDC asset", () => {
      const toml = generateToml();
      expect(toml).toContain('code="USDC"');
      expect(toml).toContain(process.env.STELLAR_ASSET_ISSUER!);
    });

    it("marks asset as 'test' on testnet", () => {
      process.env.STELLAR_NETWORK = "testnet";
      const toml = generateToml();
      // The USDC entry should have status="test"
      const usdcSection = toml
        .split("[[CURRENCIES]]")
        .find((s) => s.includes('code="USDC"'));
      expect(usdcSection).toContain('status="test"');
    });

    it("marks asset as 'live' on mainnet", () => {
      process.env.STELLAR_NETWORK = "mainnet";
      const toml = generateToml();
      const usdcSection = toml
        .split("[[CURRENCIES]]")
        .find((s) => s.includes('code="USDC"'));
      expect(usdcSection).toContain('status="live"');
    });

    it("omits non-native currency block when no asset is configured", () => {
      delete process.env.STELLAR_ASSET_CODE;
      delete process.env.STELLAR_ASSET_ISSUER;
      const toml = generateToml();
      // Only XLM block should be present
      const blocks = toml.split("[[CURRENCIES]]").filter(Boolean);
      expect(blocks).toHaveLength(1);
    });

    it("includes extra assets from STELLAR_EXTRA_ASSETS", () => {
      process.env.STELLAR_EXTRA_ASSETS = JSON.stringify([
        { code: "EURC", issuer: "GABCDE", status: "live", desc: "Euro Coin" },
      ]);
      const toml = generateToml();
      expect(toml).toContain('code="EURC"');
      expect(toml).toContain("GABCDE");
    });

    it("skips STELLAR_EXTRA_ASSETS when JSON is invalid", () => {
      process.env.STELLAR_EXTRA_ASSETS = "not-json";
      expect(() => generateToml()).not.toThrow();
      const toml = generateToml();
      expect(toml).not.toContain("EURC");
    });
  });

  describe("[DOCUMENTATION] section", () => {
    it("includes [DOCUMENTATION] header", () => {
      const toml = generateToml();
      expect(toml).toContain("[DOCUMENTATION]");
    });

    it("uses ORG_NAME env var", () => {
      process.env.ORG_NAME = "My Anchor Inc";
      const toml = generateToml();
      expect(toml).toContain('"My Anchor Inc"');
    });

    it("falls back to default org name", () => {
      delete process.env.ORG_NAME;
      const toml = generateToml();
      expect(toml).toContain("Mobile Money Anchor");
    });

    it("includes ORG_OFFICIAL_EMAIL when ORG_SUPPORT_EMAIL is set", () => {
      process.env.ORG_SUPPORT_EMAIL = "support@example.com";
      const toml = generateToml();
      expect(toml).toContain("ORG_OFFICIAL_EMAIL=");
      expect(toml).toContain("support@example.com");
    });
  });

  describe("TOML format validity", () => {
    it("all string values are double-quoted", () => {
      const toml = generateToml();
      // Every key=value line (excluding headers and booleans/numbers) should use quotes
      const keyValueLines = toml
        .split("\n")
        .filter(
          (l) => l.includes("=") && !l.startsWith("#") && !l.startsWith("["),
        );

      for (const line of keyValueLines) {
        const [, val] = line.split(/=(.*)/s);
        // Values that are NOT quoted must be boolean or numeric
        if (val && !val.trim().startsWith('"')) {
          const trimmed = val.trim();
          expect(
            ["true", "false"].includes(trimmed) || !isNaN(Number(trimmed)),
          ).toBe(true);
        }
      }
    });

    it("produces consistent output for same environment", () => {
      const a = generateToml();
      const b = generateToml();
      expect(a).toBe(b);
    });
  });
});
