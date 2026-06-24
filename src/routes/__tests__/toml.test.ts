/// <reference types="jest" />
import request from "supertest";
import express, { Express } from "express";
import tomlRouter, { assetModel, generateToml } from "../toml";

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
  process.env.STELLAR_ASSET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  process.env.STELLAR_WEB_AUTH_DOMAIN = "mobilemoney.com";
  delete process.env.STELLAR_FEDERATION_SERVER_URL;
  delete process.env.STELLAR_FEDERATION_SERVER;
  delete process.env.STELLAR_SIGNING_KEY;
  delete process.env.STELLAR_EXTRA_ASSETS;
  delete process.env.ORG_NAME;

  assetModel.findAll = jest.fn().mockResolvedValue([]);
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
    process.env.STELLAR_SIGNING_KEY = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRS";

    const after = await request(app).get("/.well-known/stellar.toml");

    expect(before.headers["etag"]).not.toBe(after.headers["etag"]);
  });
});

// ============================================================================
// generateToml — content correctness
// ============================================================================

describe("generateToml()", () => {
  describe("General section", () => {
    it("includes testnet NETWORK_PASSPHRASE for testnet", async () => {
      process.env.STELLAR_NETWORK = "testnet";
      const toml = await generateToml();
      expect(toml).toContain("Test SDF Network");
    });

    it("includes mainnet NETWORK_PASSPHRASE for mainnet", async () => {
      process.env.STELLAR_NETWORK = "mainnet";
      const toml = await generateToml();
      expect(toml).toContain("Public Global Stellar Network");
    });

    it("includes FEDERATION_SERVER line", async () => {
      const toml = await generateToml();
      expect(toml).toMatch(/FEDERATION_SERVER=/);
    });

    it("uses STELLAR_FEDERATION_SERVER env var when set", async () => {
      process.env.STELLAR_FEDERATION_SERVER = "https://custom.example.com/fed";
      const toml = await generateToml();
      expect(toml).toContain("https://custom.example.com/fed");
    });

    it("includes TRANSFER_SERVER_SEP0024 line", async () => {
      const toml = await generateToml();
      expect(toml).toMatch(/TRANSFER_SERVER_SEP0024=/);
    });

    it("includes KYC_SERVER line", async () => {
      const toml = await generateToml();
      expect(toml).toMatch(/KYC_SERVER=/);
    });

    it("includes DIRECT_PAYMENT_SERVER line", async () => {
      const toml = await generateToml();
      expect(toml).toMatch(/DIRECT_PAYMENT_SERVER=/);
    });

    it("includes SIGNING_KEY when set", async () => {
      process.env.STELLAR_SIGNING_KEY = "GABCDEFG";
      const toml = await generateToml();
      expect(toml).toContain("SIGNING_KEY=");
      expect(toml).toContain("GABCDEFG");
    });

    it("omits SIGNING_KEY when not set", async () => {
      delete process.env.STELLAR_SIGNING_KEY;
      delete process.env.STELLAR_ISSUER_ACCOUNT;
      const toml = await generateToml();
      expect(toml).not.toMatch(/^SIGNING_KEY=/m);
    });
  });

  describe("CURRENCIES section", () => {
    it("always includes native XLM entry", async () => {
      const toml = await generateToml();
      const xlmSection = toml.split("[[CURRENCIES]]").find((s) => s.includes('code="XLM"'));
      expect(xlmSection).toBeDefined();
    });

    it("includes configured USDC asset", async () => {
      const toml = await generateToml();
      expect(toml).toContain('code="USDC"');
      expect(toml).toContain(process.env.STELLAR_ASSET_ISSUER!);
    });

    it("marks asset as 'test' on testnet", async () => {
      process.env.STELLAR_NETWORK = "testnet";
      const toml = await generateToml();
      // The USDC entry should have status="test"
      const usdcSection = toml.split("[[CURRENCIES]]").find((s) => s.includes('code="USDC"'));
      expect(usdcSection).toContain('status="test"');
    });

    it("marks asset as 'live' on mainnet", async () => {
      process.env.STELLAR_NETWORK = "mainnet";
      const toml = await generateToml();
      const usdcSection = toml.split("[[CURRENCIES]]").find((s) => s.includes('code="USDC"'));
      expect(usdcSection).toContain('status="live"');
    });

    it("omits non-native currency block when no asset is configured", async () => {
      delete process.env.STELLAR_ASSET_CODE;
      delete process.env.STELLAR_ASSET_ISSUER;
      const toml = await generateToml();
      // Only the XLM currency block is present
      const blocks = toml.match(/\[\[CURRENCIES\]\]/g) || [];
      expect(blocks).toHaveLength(1);
    });

    it("includes anchored assets from the database", async () => {
      const mockAsset = {
        id: "asset-1",
        assetCode: "EURC",
        issuerPublicKey: "GABCDE12345ABCDE12345ABCDE12345ABCDE12345ABCDE12345ABCDE12345",
        issuerSecretKey: "SSECRET",
        distributionPublicKey: "GDISP12345DISP12345DISP12345DISP12345DISP12345DISP12345DISP",
        distributionSecretKey: "DSECRET",
        issuanceLimit: "1000000",
        status: "active",
        metadata: {
          desc: "Euro Coin",
          display_decimals: 2,
          is_asset_anchored: true,
          anchor_asset_type: "fiat",
          anchor_asset: "EUR",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (assetModel.findAll as jest.Mock).mockResolvedValue([mockAsset]);
      const toml = await generateToml();

      expect(toml).toContain('code="EURC"');
      expect(toml).toContain('issuer="GABCDE12345ABCDE12345ABCDE12345ABCDE12345ABCDE12345ABCDE12345"');
      expect(toml).toContain('status="test"');
      expect(toml).toContain('desc="Euro Coin"');
      expect(toml).toContain('display_decimals=2');
      expect(toml).toContain('anchor_asset_type="fiat"');
      expect(toml).toContain('anchor_asset="EUR"');
    });

    it("includes extra assets from STELLAR_EXTRA_ASSETS", async () => {
      process.env.STELLAR_EXTRA_ASSETS = JSON.stringify([
        { code: "EURC", issuer: "GABCDE", status: "live", desc: "Euro Coin" },
      ]);
      const toml = await generateToml();
      expect(toml).toContain('code="EURC"');
      expect(toml).toContain("GABCDE");
    });

    it("skips STELLAR_EXTRA_ASSETS when JSON is invalid", async () => {
      process.env.STELLAR_EXTRA_ASSETS = "not-json";
      await expect(generateToml()).resolves.not.toThrow();
      const toml = await generateToml();
      expect(toml).not.toContain("EURC");
    });
  });

  describe("[DOCUMENTATION] section", () => {
    it("includes [DOCUMENTATION] header", async () => {
      const toml = await generateToml();
      expect(toml).toContain("[DOCUMENTATION]");
    });

    it("uses ORG_NAME env var", async () => {
      process.env.ORG_NAME = "My Anchor Inc";
      const toml = await generateToml();
      expect(toml).toContain('"My Anchor Inc"');
    });

    it("falls back to default org name", async () => {
      delete process.env.ORG_NAME;
      const toml = await generateToml();
      expect(toml).toContain("Mobile Money Anchor");
    });

    it("includes ORG_OFFICIAL_EMAIL when ORG_SUPPORT_EMAIL is set", async () => {
      process.env.ORG_SUPPORT_EMAIL = "support@example.com";
      const toml = await generateToml();
      expect(toml).toContain("ORG_OFFICIAL_EMAIL=");
      expect(toml).toContain("support@example.com");
    });
  });

  describe("TOML format validity", () => {
    it("all string values are double-quoted", async () => {
      const toml = await generateToml();
      // Every key=value line (excluding headers and booleans/numbers) should use quotes
      const keyValueLines = toml
        .split("\n")
        .filter((l) => l.includes("=") && !l.startsWith("#") && !l.startsWith("["));

      for (const line of keyValueLines) {
        const [, val] = line.split(/=(.*)/s);
        // Values that are NOT quoted must be boolean or numeric
        if (val && !val.trim().startsWith('"')) {
          const trimmed = val.trim();
          expect(["true", "false"].includes(trimmed) || !isNaN(Number(trimmed))).toBe(true);
        }
      }
    });

    it("produces consistent output for same environment", async () => {
      const a = await generateToml();
      const b = await generateToml();
      expect(a).toBe(b);
    });
  });
});
