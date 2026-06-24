/**
 * Unit tests for FeeStrategyEngine
 *
 * All DB and Redis calls are mocked so tests run without infrastructure.
 */

// ── Mocks must be declared before imports ────────────────────────────────────
jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    isOpen: true,
  },
}));

jest.mock("../../src/utils/fees", () => ({
  getThirtyDayVolume: jest.fn().mockResolvedValue(0),
  mapVolumeToTier: jest.fn().mockReturnValue({ discountPercent: 0 }),
}));

import { pool } from "../../src/config/database";
import { redisClient } from "../../src/config/redis";
import { getThirtyDayVolume, mapVolumeToTier } from "../../src/utils/fees";
import {
  FeeStrategyEngine,
  FeeStrategy,
  FeeCalculationContext,
} from "../../src/services/feeStrategyEngine";

const mockPool = pool as jest.Mocked<typeof pool>;
const mockRedis = redisClient as jest.Mocked<typeof redisClient>;
const mockGetThirtyDayVolume = getThirtyDayVolume as jest.Mock;
const mockMapVolumeToTier = mapVolumeToTier as jest.Mock;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID  = "00000000-0000-0000-0000-000000000002";

function makeStrategy(overrides: Partial<FeeStrategy> = {}): FeeStrategy {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    name: "Test Strategy",
    strategyType: "percentage",
    scope: "global",
    priority: 100,
    isActive: true,
    feePercentage: 1.5,
    feeMinimum: 50,
    feeMaximum: 5000,
    createdBy: ADMIN_ID,
    updatedBy: ADMIN_ID,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

/** Build a pg-style query result from an array of strategy rows. */
function pgResult(strategies: FeeStrategy[]) {
  // Convert camelCase back to snake_case for the DB row format
  const rows = strategies.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    strategy_type: s.strategyType,
    scope: s.scope,
    user_id: s.userId ?? null,
    provider: s.provider ?? null,
    priority: s.priority,
    is_active: s.isActive,
    flat_amount: s.flatAmount ?? null,
    fee_percentage: s.feePercentage ?? null,
    fee_minimum: s.feeMinimum ?? null,
    fee_maximum: s.feeMaximum ?? null,
    days_of_week: s.daysOfWeek ?? null,
    time_start: s.timeStart ?? null,
    time_end: s.timeEnd ?? null,
    override_percentage: s.overridePercentage ?? null,
    override_flat_amount: s.overrideFlatAmount ?? null,
    volume_tiers: s.volumeTiers ?? null,
    created_by: s.createdBy,
    updated_by: s.updatedBy,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }));
  return { rows, rowCount: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("FeeStrategyEngine", () => {
  let engine: FeeStrategyEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: Redis cache miss
    mockRedis.get.mockResolvedValue(null);
    mockRedis.keys.mockResolvedValue([]);
    engine = new FeeStrategyEngine();
  });

  // ── Percentage strategy ────────────────────────────────────────────────────

  describe("PercentageFeeStrategy", () => {
    it("calculates percentage fee correctly", async () => {
      const strategy = makeStrategy({ feePercentage: 1.5, feeMinimum: 50, feeMaximum: 5000 });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(150);          // 10000 * 1.5% = 150
      expect(result.total).toBe(10_150);
      expect(result.strategyUsed).toBe("Test Strategy");
      expect(result.scopeUsed).toBe("global");
    });

    it("clamps fee to minimum", async () => {
      const strategy = makeStrategy({ feePercentage: 0.1, feeMinimum: 100, feeMaximum: 5000 });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 100 }); // 100 * 0.1% = 0.1 → clamped to 100

      expect(result.fee).toBe(100);
      expect(result.breakdown.appliedMinimum).toBe(100);
    });

    it("clamps fee to maximum", async () => {
      const strategy = makeStrategy({ feePercentage: 10, feeMinimum: 0, feeMaximum: 500 });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 100_000 }); // 100000 * 10% = 10000 → clamped to 500

      expect(result.fee).toBe(500);
      expect(result.breakdown.appliedMaximum).toBe(500);
    });
  });

  // ── Flat fee strategy ──────────────────────────────────────────────────────

  describe("FlatFeeStrategy", () => {
    it("returns fixed fee regardless of amount", async () => {
      const strategy = makeStrategy({ strategyType: "flat", flatAmount: 250, feePercentage: undefined });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 50_000 });

      expect(result.fee).toBe(250);
      expect(result.total).toBe(50_250);
    });
  });

  // ── Time-based strategy ────────────────────────────────────────────────────

  describe("TimeBasedFeeStrategy", () => {
    // 2026-04-24 is a Friday (ISO weekday 5)
    const FRIDAY = new Date("2026-04-24T12:00:00Z");
    const SATURDAY = new Date("2026-04-25T12:00:00Z");

    it("applies zero-fee override on matching day (Fee-free Fridays)", async () => {
      const timeStrategy = makeStrategy({
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5], // Friday
        overridePercentage: 0,
        feePercentage: undefined,
      });
      const fallback = makeStrategy({ priority: 100 });
      mockPool.query.mockResolvedValueOnce(pgResult([timeStrategy, fallback]) as any);

      const result = await engine.calculateFee({ amount: 10_000, evaluationTime: FRIDAY });

      expect(result.fee).toBe(0);
      expect(result.timeOverrideActive).toBe(true);
      expect(result.strategyUsed).toBe("Test Strategy");
    });

    it("falls through to next strategy when day does not match", async () => {
      const timeStrategy = makeStrategy({
        name: "Fee-free Fridays",
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5], // Friday only
        overridePercentage: 0,
        feePercentage: undefined,
      });
      const fallback = makeStrategy({ name: "Standard 1.5%", priority: 100 });
      mockPool.query.mockResolvedValueOnce(pgResult([timeStrategy, fallback]) as any);

      const result = await engine.calculateFee({ amount: 10_000, evaluationTime: SATURDAY });

      expect(result.fee).toBe(150);          // fallback 1.5%
      expect(result.timeOverrideActive).toBe(false);
      expect(result.strategyUsed).toBe("Standard 1.5%");
    });

    it("respects time window within the day", async () => {
      const timeStrategy = makeStrategy({
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5],
        timeStart: "09:00",
        timeEnd: "17:00",
        overridePercentage: 0,
        feePercentage: undefined,
      });
      const fallback = makeStrategy({ priority: 100 });

      // 08:00 UTC — before window
      const beforeWindow = new Date("2026-04-24T08:00:00Z");
      mockPool.query.mockResolvedValueOnce(pgResult([timeStrategy, fallback]) as any);
      const resultBefore = await engine.calculateFee({ amount: 10_000, evaluationTime: beforeWindow });
      expect(resultBefore.fee).toBe(150); // fallback

      // 12:00 UTC — inside window
      const insideWindow = new Date("2026-04-24T12:00:00Z");
      mockPool.query.mockResolvedValueOnce(pgResult([timeStrategy, fallback]) as any);
      const resultInside = await engine.calculateFee({ amount: 10_000, evaluationTime: insideWindow });
      expect(resultInside.fee).toBe(0);
    });
  });

  // ── Volume-based strategy ──────────────────────────────────────────────────

  describe("VolumeBasedFeeStrategy", () => {
    const volumeStrategy = makeStrategy({
      strategyType: "volume_based",
      feePercentage: undefined,
      volumeTiers: [
        { minAmount: 0,       maxAmount: 100_000, feePercentage: 1.5 },
        { minAmount: 100_000, maxAmount: null,    feePercentage: 0.8 },
      ],
    });

    it("applies lower tier for small amounts", async () => {
      mockPool.query.mockResolvedValueOnce(pgResult([volumeStrategy]) as any);
      const result = await engine.calculateFee({ amount: 50_000 });
      expect(result.fee).toBe(750); // 50000 * 1.5%
    });

    it("applies reduced tier for large amounts", async () => {
      mockPool.query.mockResolvedValueOnce(pgResult([volumeStrategy]) as any);
      const result = await engine.calculateFee({ amount: 200_000 });
      expect(result.fee).toBe(1600); // 200000 * 0.8%
    });

    it("returns zero fee when no tier matches", async () => {
      const emptyTierStrategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        volumeTiers: [{ minAmount: 500_000, maxAmount: null, feePercentage: 0.5 }],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([emptyTierStrategy]) as any);
      const result = await engine.calculateFee({ amount: 100 }); // below all tiers
      expect(result.fee).toBe(0);
    });
  });

  // ── Priority resolution ────────────────────────────────────────────────────

  describe("Priority resolution", () => {
    it("user-scope strategy beats global strategy", async () => {
      const globalStrategy = makeStrategy({
        name: "Global 1.5%",
        scope: "global",
        priority: 100,
        feePercentage: 1.5,
      });
      const userStrategy = makeStrategy({
        id: "bbbbbbbb-0000-0000-0000-000000000001",
        name: "User 0.5%",
        scope: "user",
        userId: USER_ID,
        priority: 10,
        feePercentage: 0.5,
      });

      // Engine orders: user first, then global
      mockPool.query.mockResolvedValueOnce(pgResult([userStrategy, globalStrategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000, userId: USER_ID });

      expect(result.fee).toBe(50);           // 10000 * 0.5%
      expect(result.scopeUsed).toBe("user");
      expect(result.strategyUsed).toBe("User 0.5%");
    });

    it("provider-scope strategy beats global strategy", async () => {
      const globalStrategy = makeStrategy({
        name: "Global 1.5%",
        scope: "global",
        priority: 100,
        feePercentage: 1.5,
      });
      const providerStrategy = makeStrategy({
        id: "cccccccc-0000-0000-0000-000000000001",
        name: "Orange 1%",
        scope: "provider",
        provider: "orange",
        priority: 50,
        feePercentage: 1.0,
      });

      mockPool.query.mockResolvedValueOnce(pgResult([providerStrategy, globalStrategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000, provider: "orange" });

      expect(result.fee).toBe(100);          // 10000 * 1%
      expect(result.scopeUsed).toBe("provider");
    });

    it("user-scope beats provider-scope beats global", async () => {
      const globalStrategy = makeStrategy({
        name: "Global 1.5%",
        scope: "global",
        priority: 100,
        feePercentage: 1.5,
      });
      const providerStrategy = makeStrategy({
        id: "cccccccc-0000-0000-0000-000000000001",
        name: "Orange 1%",
        scope: "provider",
        provider: "orange",
        priority: 50,
        feePercentage: 1.0,
      });
      const userStrategy = makeStrategy({
        id: "bbbbbbbb-0000-0000-0000-000000000001",
        name: "VIP 0.2%",
        scope: "user",
        userId: USER_ID,
        priority: 10,
        feePercentage: 0.2,
      });

      mockPool.query.mockResolvedValueOnce(pgResult([userStrategy, providerStrategy, globalStrategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000, userId: USER_ID, provider: "orange" });

      expect(result.fee).toBe(20);           // 10000 * 0.2%
      expect(result.scopeUsed).toBe("user");
    });

    it("lower priority number wins within same scope", async () => {
      const highPriority = makeStrategy({
        name: "High Priority 0.5%",
        scope: "global",
        priority: 10,
        feePercentage: 0.5,
      });
      const lowPriority = makeStrategy({
        id: "dddddddd-0000-0000-0000-000000000001",
        name: "Low Priority 2%",
        scope: "global",
        priority: 200,
        feePercentage: 2.0,
      });

      // DB returns them already ordered by priority ASC
      mockPool.query.mockResolvedValueOnce(pgResult([highPriority, lowPriority]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(50);           // 10000 * 0.5%
      expect(result.strategyUsed).toBe("High Priority 0.5%");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("returns zero fee when no strategies are configured", async () => {
      mockPool.query.mockResolvedValueOnce(pgResult([]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(0);
      expect(result.strategyUsed).toBe("none");
    });

    it("handles zero-amount transaction", async () => {
      const strategy = makeStrategy({ feePercentage: 1.5, feeMinimum: 0 });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 0 });

      expect(result.fee).toBe(0);
      expect(result.total).toBe(0);
    });

    it("uses Redis cache on second call", async () => {
      const strategy = makeStrategy();
      const cached = JSON.stringify([strategy]);
      mockRedis.get.mockResolvedValueOnce(cached);

      const result = await engine.calculateFee({ amount: 10_000 });

      // DB should NOT be called because cache hit
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(result.fee).toBe(150);
    });

    it("falls back to DB when Redis is unavailable", async () => {
      mockRedis.get.mockRejectedValueOnce(new Error("Redis down"));
      const strategy = makeStrategy();
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(150);
    });
  });

  // ── CRUD operations ────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("createStrategy inserts and returns the new strategy", async () => {
      const strategy = makeStrategy();
      // First call: INSERT RETURNING
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);
      // Second call: audit INSERT
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await engine.createStrategy(
        {
          name: "Test Strategy",
          strategyType: "percentage",
          scope: "global",
          feePercentage: 1.5,
          feeMinimum: 50,
          feeMaximum: 5000,
        },
        ADMIN_ID,
      );

      expect(result.name).toBe("Test Strategy");
      expect(result.feePercentage).toBe(1.5);
    });

    it("updateStrategy returns null for unknown ID", async () => {
      // getStrategyById returns null
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await engine.updateStrategy(
        "non-existent-id",
        { feePercentage: 2.0 },
        ADMIN_ID,
      );

      expect(result).toBeNull();
    });

    it("deleteStrategy returns false for unknown ID", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await engine.deleteStrategy("non-existent-id", ADMIN_ID);

      expect(result).toBe(false);
    });

    it("activateStrategy sets is_active to true", async () => {
      const inactive = makeStrategy({ isActive: false });
      const active = makeStrategy({ isActive: true });

      // getStrategyById
      mockPool.query.mockResolvedValueOnce(pgResult([inactive]) as any);
      // UPDATE RETURNING
      mockPool.query.mockResolvedValueOnce(pgResult([active]) as any);
      // audit INSERT
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await engine.activateStrategy(inactive.id, ADMIN_ID);

      expect(result?.isActive).toBe(true);
    });

    it("deactivateStrategy sets is_active to false", async () => {
      const active = makeStrategy({ isActive: true });
      const inactive = makeStrategy({ isActive: false });

      mockPool.query.mockResolvedValueOnce(pgResult([active]) as any);
      mockPool.query.mockResolvedValueOnce(pgResult([inactive]) as any);
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await engine.deactivateStrategy(active.id, ADMIN_ID);

      expect(result?.isActive).toBe(false);
    });
  });

  // ── Cache invalidation ─────────────────────────────────────────────────────

  describe("Cache invalidation", () => {
    it("invalidates all cache keys after createStrategy", async () => {
      const strategy = makeStrategy();
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      mockRedis.keys.mockResolvedValueOnce(["fee_strategies:resolved::"]);

      await engine.createStrategy(
        { name: "X", strategyType: "flat", scope: "global", flatAmount: 100 },
        ADMIN_ID,
      );

      expect(mockRedis.keys).toHaveBeenCalledWith("fee_strategies:*");
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  // ── VIP Fee Discounts ──────────────────────────────────────────────────────

  describe("VIP Fee Discounts", () => {
    it("applies VIP discount to strategy fee when user has volume", async () => {
      const strategy = makeStrategy({
        name: "Standard 2%",
        scope: "global",
        priority: 100,
        feePercentage: 2.0,
        feeMinimum: 50,
        feeMaximum: 5000,
      });

      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);
      mockGetThirtyDayVolume.mockResolvedValueOnce(1500); // qualifies for tier/discount
      mockMapVolumeToTier.mockReturnValueOnce({ discountPercent: 10 }); // 10% discount

      // 10,000 * 2% = 200 fee. With 10% discount, 200 * 0.9 = 180 fee.
      const result = await engine.calculateFee({ amount: 10_000, userId: USER_ID });

      expect(result.fee).toBe(180);
      expect(result.total).toBe(10180);
      expect(result.breakdown.clampedFee).toBe(180);
      expect(result.breakdown.rawFee).toBe(180);
    });

    it("applies VIP discount to minimum fee if minimum is triggered", async () => {
      const strategy = makeStrategy({
        name: "Standard 2% with Min 100",
        scope: "global",
        priority: 100,
        feePercentage: 2.0,
        feeMinimum: 100,
        feeMaximum: 5000,
      });

      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);
      mockGetThirtyDayVolume.mockResolvedValueOnce(1500);
      mockMapVolumeToTier.mockReturnValueOnce({ discountPercent: 10 });

      // Amount: 1,000. 1,000 * 2% = 20 (raw). Min: 100.
      // With 10% discount:
      // Discounted raw: 20 * 0.9 = 18.
      // Discounted min: 100 * 0.9 = 90.
      // Since discounted raw (18) < discounted min (90), final fee is 90.
      const result = await engine.calculateFee({ amount: 1000, userId: USER_ID });

      expect(result.fee).toBe(90);
      expect(result.total).toBe(1090);
      expect(result.breakdown.appliedMinimum).toBe(90);
    });
  });
});

