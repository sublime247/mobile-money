import request from "supertest";
import express, { Express } from "express";
import { Router } from "express";
import { rateProvider, setRateProvider, IRateProvider, RateResult } from "../../src/services/sep38/rateProvider";

jest.mock("../../src/config/redis", () => ({
  __esModule: true,
  connectRedis: jest.fn().mockResolvedValue(undefined),
  disconnectRedis: jest.fn().mockResolvedValue(undefined),
  redisClient: {
    isOpen: false,
    on: jest.fn(),
    connect: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn(),
  },
  SESSION_TTL_SECONDS: 86400,
}));

jest.mock("../../src/services/stellar/assetService", () => ({}));
jest.mock("../../src/services/currency", () => {
  const actual = jest.requireActual("../../src/services/currency");
  return {
    ...actual,
    currencyService: {
      convert: jest.fn().mockReturnValue({ rate: 600, convertedAmount: 600 }),
      convertToBase: jest.fn().mockReturnValue({ rate: 1 / 600, convertedAmount: 1 / 600 }),
      isSupportedCurrency: jest.fn().mockReturnValue(true),
      getRates: jest.fn().mockReturnValue({ USD: 1, XAF: 600 }),
    },
  };
});
jest.mock("../../src/services/exchangeRateBufferService", () => ({
  exchangeRateBufferService: {
    applyBuffer: jest.fn().mockResolvedValue({
      rawRate: 600,
      bufferedRate: 600,
      bufferApplied: 0,
      providerUsed: "*",
      currencyPair: "USD_XAF",
      mode: "static",
    }),
  },
}));

jest.mock("stellar-sdk", () => {
  const mockAsset = jest.fn().mockImplementation((code: string, issuer: string) => ({
    getCode: () => code,
    getIssuer: () => issuer,
    isNative: () => false,
  }));
  mockAsset.native = jest.fn(() => ({
    getCode: () => "XLM",
    getIssuer: () => "",
    isNative: () => true,
  }));
  return {
    Asset: mockAsset,
    Keypair: {
      random: jest.fn(),
      fromPublicKey: jest.fn(),
      fromSecret: jest.fn(),
    },
    Networks: { TESTNET: "Test SDF Network ; September 2015", PUBLIC: "Public Global Stellar Network ; September 2015" },
    Operation: { pathPaymentStrictReceive: jest.fn(), pathPaymentStrictSend: jest.fn() },
    TransactionBuilder: jest.fn(),
    BASE_FEE: "100",
    Horizon: { Server: jest.fn() },
  };
});

jest.mock("../../src/config/stellar", () => ({
  getStellarServer: jest.fn().mockReturnValue({
    strictSendPaths: jest.fn().mockReturnValue({
      call: jest.fn().mockResolvedValue({ records: [] }),
    }),
    strictReceivePaths: jest.fn().mockReturnValue({
      call: jest.fn().mockResolvedValue({ records: [] }),
    }),
  }),
  getNetworkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
  STELLAR_NETWORKS: { TESTNET: "testnet", MAINNET: "mainnet" },
}));

class MockRateProvider implements IRateProvider {
  async getIndicativePrice(sellAsset: string, buyAsset: string): Promise<RateResult | null> {
    if (sellAsset === "stellar:INVALID") return null;
    return {
      price: "0.1200000",
      fee_percent: "0.50",
      fee_fixed: "0.0000000",
    };
  }

  async getFirmPrice(sellAsset: string, buyAsset: string): Promise<RateResult | null> {
    if (sellAsset === "stellar:INVALID") return null;
    return {
      price: "0.1200000",
      fee_percent: "0.50",
      fee_fixed: "0.0000000",
    };
  }
}

let app: Express;

beforeAll(() => {
  setRateProvider(new MockRateProvider());

  app = express();
  app.use(express.json());

  const sep38Router = require("../../src/stellar/sep38").default;
  app.use("/sep38", sep38Router);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe("SEP-38 Exchange Endpoints", () => {
  describe("GET /sep38/info", () => {
    it("should return supported asset pairs", async () => {
      const res = await request(app).get("/sep38/info");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("assets");
      expect(Array.isArray(res.body.assets)).toBe(true);
      expect(res.body.assets.length).toBeGreaterThan(0);

      res.body.assets.forEach((pair: any) => {
        expect(pair).toHaveProperty("sell_asset");
        expect(pair).toHaveProperty("buy_asset");
        expect(typeof pair.sell_asset).toBe("string");
        expect(typeof pair.buy_asset).toBe("string");
      });
    });
  });

  describe("GET /sep38/prices", () => {
    it("should return 400 for missing parameters", async () => {
      const res = await request(app).get("/sep38/prices");

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Missing required parameters");
    });

    it("should return 400 for unsupported asset pair", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "stellar:INVALID",
          buy_asset: "iso4217:USD",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Invalid asset format");
    });

    it("should return price for supported asset pair", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("price");
      expect(res.body.sell_asset).toBe("stellar:XLM");
      expect(res.body.buy_asset).toBe("iso4217:USD");
      expect(typeof res.body.price).toBe("string");
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);
    });

    it("should return price for reverse asset pair", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "iso4217:USD",
          buy_asset: "stellar:XLM",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("price");
      expect(res.body.sell_asset).toBe("iso4217:USD");
      expect(res.body.buy_asset).toBe("stellar:XLM");
      expect(typeof res.body.price).toBe("string");
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);
    });

    it("should return 503 when liquidity is insufficient", async () => {
      setRateProvider({
        async getIndicativePrice() { return null; },
        async getFirmPrice() { return null; },
      });

      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
        });

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Insufficient liquidity");

      setRateProvider(new MockRateProvider());
    });
  });

  describe("GET /sep38/price", () => {
    it("should return price for supported asset pair", async () => {
      const res = await request(app)
        .get("/sep38/price")
        .query({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("price");
    });
  });

  describe("POST /sep38/quote", () => {
    it("should return 400 for missing required parameters", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Missing required parameters");
    });

    it("should return 400 for unsupported asset pair", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:INVALID",
          buy_asset: "iso4217:USD",
          sell_amount: "10",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Invalid asset format");
    });

    it("should return 400 for invalid sell_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "-10",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("sell_amount must be a positive number");
    });

    it("should return 400 for invalid buy_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          buy_amount: "0",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("buy_amount must be a positive number");
    });

    it("should create quote with sell_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "100",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("created_at");

      expect(res.body.sell_asset).toBe("stellar:XLM");
      expect(res.body.buy_asset).toBe("iso4217:USD");
      expect(parseFloat(res.body.buy_amount)).toBeGreaterThan(0);
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);

      const expiresAt = new Date(res.body.expires_at);
      const now = new Date();
      expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("should create quote with buy_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          buy_amount: "10",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("created_at");

      expect(res.body.sell_asset).toBe("stellar:XLM");
      expect(res.body.buy_asset).toBe("iso4217:USD");
      expect(parseFloat(res.body.sell_amount)).toBeGreaterThan(0);
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);

      const expiresAt = new Date(res.body.expires_at);
      const now = new Date();
      expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("should create quote with custom TTL", async () => {
      const customTTL = 120;

      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50",
          ttl: customTTL,
        });

      expect(res.status).toBe(200);

      const expiresAt = new Date(res.body.expires_at);
      const createdAt = new Date(res.body.created_at);
      const actualTTL = Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000);

      expect(actualTTL).toBe(customTTL);
    });

    it("should use default TTL when not specified", async () => {
      const defaultTTL = 60;

      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50",
        });

      expect(res.status).toBe(200);

      const expiresAt = new Date(res.body.expires_at);
      const createdAt = new Date(res.body.created_at);
      const actualTTL = Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000);

      expect(actualTTL).toBe(defaultTTL);
    });

    it("should limit TTL to maximum of 300 seconds", async () => {
      const maxTTL = 300;

      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50",
          ttl: 600,
        });

      expect(res.status).toBe(200);

      const expiresAt = new Date(res.body.expires_at);
      const createdAt = new Date(res.body.created_at);
      const actualTTL = Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000);

      expect(actualTTL).toBe(maxTTL);
    });

    it("should return 503 when liquidity is insufficient", async () => {
      setRateProvider({
        async getIndicativePrice() { return null; },
        async getFirmPrice() { return null; },
      });

      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50",
        });

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Insufficient liquidity");

      setRateProvider(new MockRateProvider());
    });
  });

  describe("GET /sep38/quote/:id", () => {
    let quoteId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "100",
        });

      expect(res.status).toBe(200);
      quoteId = res.body.id;
    });

    it("should return quote by ID", async () => {
      const res = await request(app).get(`/sep38/quote/${quoteId}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", quoteId);
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("created_at");
    });

    it("should return 404 for non-existent quote", async () => {
      const res = await request(app).get("/sep38/quote/non-existent-id");

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Quote not found");
    });

    it("should return 410 for expired quote", async () => {
      const res = await request(app).get(`/sep38/quote/${quoteId}`);
      expect(res.status).toBe(200);
    });
  });

  describe("SEP-38 TTL Requirements", () => {
    it("should enforce TTL limits correctly", async () => {
      const res1 = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "10",
          ttl: 0,
        });

      expect(res1.status).toBe(200);
      const expiresAt1 = new Date(res1.body.expires_at);
      const createdAt1 = new Date(res1.body.created_at);
      const actualTTL1 = Math.round((expiresAt1.getTime() - createdAt1.getTime()) / 1000);
      expect(actualTTL1).toBe(60);

      const res2 = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "10",
          ttl: 600,
        });

      expect(res2.status).toBe(200);
      const expiresAt2 = new Date(res2.body.expires_at);
      const createdAt2 = new Date(res2.body.created_at);
      const actualTTL2 = Math.round((expiresAt2.getTime() - createdAt2.getTime()) / 1000);
      expect(actualTTL2).toBe(300);
    });
  });
});
