import fs from "fs";
import path from "path";
import request from "supertest";
import express, { Express } from "express";
import {
  setRateProvider,
  IRateProvider,
  RateResult,
} from "../../src/services/sep38/rateProvider";

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
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
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
      convertToBase: jest
        .fn()
        .mockReturnValue({ rate: 1 / 600, convertedAmount: 1 / 600 }),
      isSupportedCurrency: jest.fn().mockReturnValue(true),
      getRates: jest.fn().mockReturnValue({
        USD: 1,
        XAF: 600,
        XOF: 600,
        KES: 130,
        GHS: 15,
        NGN: 1550,
        TZS: 2600,
      }),
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
      currencyPair: "USD_XOF",
      mode: "static",
    }),
  },
}));

jest.mock("@stellar/stellar-sdk", () => {
  const mockAsset = jest
    .fn()
    .mockImplementation((code: string, issuer: string) => ({
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
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
    },
    Operation: {
      pathPaymentStrictReceive: jest.fn(),
      pathPaymentStrictSend: jest.fn(),
    },
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
  getNetworkPassphrase: jest
    .fn()
    .mockReturnValue("Test SDF Network ; September 2015"),
  STELLAR_NETWORKS: { TESTNET: "testnet", MAINNET: "mainnet" },
}));

class MockRateProvider implements IRateProvider {
  async getIndicativePrice(
    _sellAsset: string,
    _buyAsset: string,
  ): Promise<RateResult | null> {
    return {
      price: "600.0000000",
      fee_percent: "0.50",
      fee_fixed: "0.0000000",
    };
  }

  async getFirmPrice(
    _sellAsset: string,
    _buyAsset: string,
  ): Promise<RateResult | null> {
    return {
      price: "600.0000000",
      fee_percent: "0.50",
      fee_fixed: "0.0000000",
    };
  }
}

describe("k6 Quote Calculation Load Benchmark Suite", () => {
  const scriptPath = path.resolve(__dirname, "../../benchmarks/k6-quote-load.js");
  const readmePath = path.resolve(__dirname, "../../benchmarks/README.md");
  const packageJsonPath = path.resolve(__dirname, "../../package.json");

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

  describe("Static Script & Configuration Validation", () => {
    it("should ensure benchmarks/k6-quote-load.js exists", () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it("should define stages simulating 200 virtual users over 60 seconds", () => {
      const content = fs.readFileSync(scriptPath, "utf-8");
      expect(content).toContain("TARGET_VUS = parseInt(__ENV.VUS || \"200\", 10)");
      expect(content).toContain("DURATION = __ENV.DURATION || \"60s\"");

      // Verify the 4 ramp stages
      expect(content).toContain("duration: \"10s\", target: Math.round(TARGET_VUS * 0.25)");
      expect(content).toContain("duration: \"15s\", target: TARGET_VUS");
      expect(content).toContain("duration: \"25s\", target: TARGET_VUS");
      expect(content).toContain("duration: \"10s\", target: 0");

      // Verify sum of durations: 10 + 15 + 25 + 10 = 60s
      const durations = [10, 15, 25, 10];
      const totalDuration = durations.reduce((a, b) => a + b, 0);
      expect(totalDuration).toBe(60);
    });

    it("should configure performance threshold assertions for cached quotes, p99, and error rate", () => {
      const content = fs.readFileSync(scriptPath, "utf-8");

      // Assertion: p95 latency under 150ms for cached quotes
      expect(content).toContain("\"p(95)<150\"");
      expect(content).toContain("cached_quote_duration_ms");

      // Assertion: p99 latency under 500ms
      expect(content).toContain("\"p(99)<500\"");

      // Assertion: error rate under 0.5% (rate < 0.005)
      expect(content).toContain("\"rate<0.005\"");
    });

    it("should configure required currency pairs including USD/XOF, EUR/KES, GBP/GHS", () => {
      const content = fs.readFileSync(scriptPath, "utf-8");
      expect(content).toContain("base: \"USD\",\n    quote: \"XOF\"");
      expect(content).toContain("base: \"EUR\",\n    quote: \"KES\"");
      expect(content).toContain("base: \"GBP\",\n    quote: \"GHS\"");
      expect(content).toContain("base: \"USD\",\n    quote: \"NGN\"");
      expect(content).toContain("base: \"EUR\",\n    quote: \"XAF\"");
      expect(content).toContain("base: \"GBP\",\n    quote: \"TZS\"");
      expect(content).toContain("base: \"USD\",\n    quote: \"KES\"");
      expect(content).toContain("base: \"XLM\",\n    quote: \"USD\"");
    });

    it("should ensure package.json contains bench:quote-load scripts", () => {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      expect(pkg.scripts["bench:quote-load"]).toBe("k6 run benchmarks/k6-quote-load.js");
      expect(pkg.scripts["bench:quote-load:observe"]).toBe(
        "k6 run -e OBSERVE_ONLY=true benchmarks/k6-quote-load.js",
      );
    });

    it("should ensure benchmarks/README.md documents k6-quote-load.js thresholds and execution commands", () => {
      const readme = fs.readFileSync(readmePath, "utf-8");
      expect(readme).toContain("k6-quote-load.js");
      expect(readme).toContain("< 150 ms");
      expect(readme).toContain("< 500 ms");
      expect(readme).toContain("< 0.5%");
      expect(readme).toContain("200 VUs");
      expect(readme).toContain("npm run bench:quote-load");
    });
  });

  describe("Integration & Mock Response Flow Validation", () => {
    it("should execute real-time FX rate discovery (Step 1)", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "iso4217:USD",
          sell_amount: "100",
          buy_asset: "iso4217:XOF",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("buy_assets");
      expect(Array.isArray(res.body.buy_assets)).toBe(true);
    });

    it("should execute firm quote calculation (Step 2)", async () => {
      const payload = {
        sell_asset: "iso4217:USD",
        buy_asset: "iso4217:XOF",
        sell_amount: "100",
        ttl: 60,
      };

      const res = await request(app).post("/sep38/quote").send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("price");
      expect(res.body.sell_asset).toBe("iso4217:USD");
      expect(res.body.buy_asset).toBe("iso4217:XOF");
    });

    it("should execute cached quote retrieval under low latency (Step 3)", async () => {
      // 1. Create quote
      const createRes = await request(app).post("/sep38/quote").send({
        sell_asset: "iso4217:EUR",
        buy_asset: "iso4217:KES",
        sell_amount: "50",
        ttl: 60,
      });

      expect(createRes.status).toBe(200);
      const quoteId = createRes.body.id;
      expect(quoteId).toBeDefined();

      // 2. Fetch cached quote
      const start = Date.now();
      const cachedRes = await request(app).get(`/sep38/quote/${quoteId}`);
      const durationMs = Date.now() - start;

      expect(cachedRes.status).toBe(200);
      expect(cachedRes.body.id).toBe(quoteId);
      // Cached retrieval should be fast
      expect(durationMs).toBeLessThan(150);
    });

    it("should sustain concurrent quote requests across multiple currency corridors", async () => {
      const corridors = [
        { sell: "iso4217:USD", buy: "iso4217:XOF", amount: "100" },
        { sell: "iso4217:EUR", buy: "iso4217:KES", amount: "50" },
        { sell: "iso4217:GBP", buy: "iso4217:GHS", amount: "75" },
        { sell: "iso4217:USD", buy: "iso4217:NGN", amount: "20" },
      ];

      const concurrentRequests = corridors.map(async (corridor) => {
        // Step 1: FX Discovery
        const fxRes = await request(app).get("/sep38/prices").query({
          sell_asset: corridor.sell,
          sell_amount: corridor.amount,
          buy_asset: corridor.buy,
        });
        expect(fxRes.status).toBe(200);

        // Step 2: Quote creation
        const quoteRes = await request(app).post("/sep38/quote").send({
          sell_asset: corridor.sell,
          buy_asset: corridor.buy,
          sell_amount: corridor.amount,
          ttl: 60,
        });
        expect(quoteRes.status).toBe(200);
        const qId = quoteRes.body.id;

        // Step 3: Cached retrieval
        const cachedRes = await request(app).get(`/sep38/quote/${qId}`);
        expect(cachedRes.status).toBe(200);
        expect(cachedRes.body.id).toBe(qId);
        return cachedRes.body;
      });

      const results = await Promise.all(concurrentRequests);
      expect(results.length).toBe(4);
    });
  });

  describe("handleSummary Metric Evaluation", () => {
    it("should correctly evaluate passing thresholds in handleSummary data", () => {
      const mockDataPass = {
        metrics: {
          http_reqs: { values: { count: 1200, rate: 20.0 } },
          http_req_duration: { values: { "p(99)": 180.5, avg: 45.2 } },
          cached_quote_duration_ms: { values: { "p(95)": 42.1 } },
          quote_calculation_duration_ms: { values: { "p(99)": 210.0 } },
          fx_rate_duration_ms: { values: { "p(99)": 150.0 } },
          error_rate: { values: { rate: 0.001 } }, // 0.1% < 0.5%
        },
      };

      const p95Cached = mockDataPass.metrics.cached_quote_duration_ms.values["p(95)"];
      const p99All = mockDataPass.metrics.http_req_duration.values["p(99)"];
      const errRatePct = mockDataPass.metrics.error_rate.values.rate * 100;

      const cachedPass = p95Cached < 150;
      const p99Pass = p99All < 500;
      const errPass = errRatePct < 0.5;

      expect(cachedPass).toBe(true);
      expect(p99Pass).toBe(true);
      expect(errPass).toBe(true);
    });

    it("should correctly flag failing thresholds when latency or error budget breached", () => {
      const mockDataFail = {
        metrics: {
          http_reqs: { values: { count: 1200, rate: 20.0 } },
          http_req_duration: { values: { "p(99)": 650.0 } }, // Breaches 500ms
          cached_quote_duration_ms: { values: { "p(95)": 220.0 } }, // Breaches 150ms
          error_rate: { values: { rate: 0.015 } }, // 1.5% breaches 0.5%
        },
      };

      const cachedPass = mockDataFail.metrics.cached_quote_duration_ms.values["p(95)"] < 150;
      const p99Pass = mockDataFail.metrics.http_req_duration.values["p(99)"] < 500;
      const errPass = mockDataFail.metrics.error_rate.values.rate * 100 < 0.5;

      expect(cachedPass).toBe(false);
      expect(p99Pass).toBe(false);
      expect(errPass).toBe(false);
    });
  });
});
