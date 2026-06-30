import { ExchangeRateBufferService } from "../exchangeRateBufferService";

// Mock dependencies
jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: false,
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../models/historicalPrice", () => ({
  findRange: jest.fn().mockResolvedValue([]),
}));

jest.mock("../logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { pool } from "../../config/database";
import { findRange } from "../../models/historicalPrice";

describe("ExchangeRateBufferService", () => {
  let service: ExchangeRateBufferService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ExchangeRateBufferService();
  });

  describe("applyBuffer", () => {
    it("should return raw rate when no buffer config exists", async () => {
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await service.applyBuffer(
        600,
        "mtn",
        "USD",
        "XAF",
        "sell",
      );

      expect(result.rawRate).toBe(600);
      expect(result.bufferedRate).toBe(600);
      expect(result.bufferApplied).toBe(0);
      expect(result.providerUsed).toBe("none");
    });

    it("should apply static buffer for sell direction", async () => {
      // First call: exact provider match
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: "buf-1",
            provider: "mtn",
            currency_pair: "USD_XAF",
            buffer_percent: "2.0000",
            min_buffer_pct: "0.1000",
            max_buffer_pct: "5.0000",
            volatility_mode: "static",
            is_active: true,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const result = await service.applyBuffer(
        600,
        "mtn",
        "USD",
        "XAF",
        "sell",
      );

      expect(result.rawRate).toBe(600);
      // sell: rate / (1 + 0.02) = 600 / 1.02 ≈ 588.2352941
      expect(result.bufferedRate).toBeCloseTo(588.2352941, 4);
      expect(result.bufferApplied).toBe(2);
      expect(result.mode).toBe("static");
    });

    it("should apply static buffer for buy direction", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: "buf-1",
            provider: "mtn",
            currency_pair: "USD_XAF",
            buffer_percent: "2.0000",
            min_buffer_pct: "0.1000",
            max_buffer_pct: "5.0000",
            volatility_mode: "static",
            is_active: true,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const result = await service.applyBuffer(600, "mtn", "USD", "XAF", "buy");

      // buy: rate * (1 + 0.02) = 600 * 1.02 = 612
      expect(result.bufferedRate).toBeCloseTo(612, 4);
      expect(result.bufferApplied).toBe(2);
    });

    it("should fall back to wildcard provider when no exact match", async () => {
      // First query (exact match): no rows
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      // Second query (wildcard): match
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: "buf-global",
            provider: "*",
            currency_pair: "USD_XAF",
            buffer_percent: "1.5000",
            min_buffer_pct: "0.1000",
            max_buffer_pct: "5.0000",
            volatility_mode: "static",
            is_active: true,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const result = await service.applyBuffer(
        600,
        "airtel",
        "USD",
        "XAF",
        "sell",
      );

      expect(result.providerUsed).toBe("*");
      expect(result.bufferApplied).toBe(1.5);
    });

    it("should clamp dynamic buffer to min/max bounds", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: "buf-dyn",
            provider: "mtn",
            currency_pair: "XLM_USD",
            buffer_percent: "1.0000",
            min_buffer_pct: "0.5000",
            max_buffer_pct: "3.0000",
            volatility_mode: "dynamic",
            is_active: true,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      // Return high-volatility price data → dynamic buffer would be very high
      (findRange as jest.Mock).mockResolvedValueOnce([
        { price: 0.1, recordedAt: new Date(), source: "test" },
        { price: 0.15, recordedAt: new Date(), source: "test" },
        { price: 0.08, recordedAt: new Date(), source: "test" },
        { price: 0.2, recordedAt: new Date(), source: "test" },
      ]);

      const result = await service.applyBuffer(
        0.12,
        "mtn",
        "XLM",
        "USD",
        "sell",
      );

      // Dynamic buffer would be large, but should be clamped to max 3%
      expect(result.bufferApplied).toBeLessThanOrEqual(3);
      expect(result.bufferApplied).toBeGreaterThanOrEqual(0.5);
      expect(result.mode).toBe("dynamic");
    });

    it("should fall back to static buffer when not enough price history", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: "buf-dyn",
            provider: "mtn",
            currency_pair: "XLM_USD",
            buffer_percent: "1.5000",
            min_buffer_pct: "0.5000",
            max_buffer_pct: "3.0000",
            volatility_mode: "dynamic",
            is_active: true,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      // Only 1 data point — not enough for volatility calc
      (findRange as jest.Mock).mockResolvedValueOnce([
        { price: 0.12, recordedAt: new Date(), source: "test" },
      ]);

      const result = await service.applyBuffer(
        0.12,
        "mtn",
        "XLM",
        "USD",
        "sell",
      );

      // Falls back to static buffer_percent of 1.5
      expect(result.bufferApplied).toBe(1.5);
    });
  });

  describe("CRUD operations", () => {
    it("should create a buffer config", async () => {
      const mockRow = {
        id: "new-id",
        provider: "mtn",
        currency_pair: "USD_XAF",
        buffer_percent: "2.0000",
        min_buffer_pct: "0.1000",
        max_buffer_pct: "5.0000",
        volatility_mode: "static",
        is_active: true,
        created_by: "user-1",
        updated_by: "user-1",
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Create query
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockRow] });
      // Audit query
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await service.createBuffer(
        {
          provider: "mtn",
          currencyPair: "USD_XAF",
          bufferPercent: 2.0,
        },
        "user-1",
      );

      expect(result.provider).toBe("mtn");
      expect(result.bufferPercent).toBe(2);
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("should list all buffers", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            provider: "mtn",
            currency_pair: "USD_XAF",
            buffer_percent: "2.0000",
            min_buffer_pct: "0.1000",
            max_buffer_pct: "5.0000",
            volatility_mode: "static",
            is_active: true,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const result = await service.getAllBuffers();

      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe("mtn");
    });
  });
});
