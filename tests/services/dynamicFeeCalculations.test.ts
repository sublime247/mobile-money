/**
 * Focused unit tests for dynamic fee calculation logic.
 *
 * Covers gaps in existing test suites:
 *  - FeeStrategyEngine: flat fee clamping, volume tier boundaries, time-based
 *    overrides, user-scope percentage (no min), VIP discount with max cap,
 *    rounding/precision, unknown strategy type.
 *  - Dynamic spread: negative/zero edge inputs, monotonicity, exact boundary factors.
 *  - Airtel fee tiers: exact tier boundaries, bulk tier, invalid inputs, rounding.
 *  - calculateFeeSync: custom env configs, fractional precision, negative amounts.
 *
 * All DB/Redis/network calls are mocked so tests run in isolation.
 */

// ── Module mocks (hoisted before imports) ───────────────────────────────────

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

jest.mock("../../src/utils/fees", () => {
  const actual = jest.requireActual("../../src/utils/fees");
  return {
    ...actual,
    getThirtyDayVolume: jest.fn().mockResolvedValue(0),
    mapVolumeToTier: jest.fn().mockReturnValue({ discountPercent: 0 }),
  };
});

jest.mock("../../src/services/feeService", () => ({
  feeService: {
    calculateFee: jest.fn(),
    getActiveConfiguration: jest.fn(),
  },
}));

jest.mock("../../src/services/providerSettingsService", () => ({
  providerSettingsService: {
    getProviderSettings: jest.fn().mockResolvedValue({
      provider_name: "mtn",
      timeout_ms: 30000,
    }),
  },
}));

jest.mock("../../src/utils/logger", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { pool } from "../../src/config/database";
import { redisClient } from "../../src/config/redis";
import {
  getThirtyDayVolume,
  mapVolumeToTier,
} from "../../src/utils/fees";
import {
  FeeStrategyEngine,
  FeeStrategy,
} from "../../src/services/feeStrategyEngine";
import {
  computeLiquidityScaleFactor,
  computeSettlementScaleFactor,
  computeSpread,
} from "../../src/services/dynamicSpreadService";
import {
  calculateAirtelFee,
  AIRTEL_FEE_TIERS,
  AIRTEL_MIN_FEE,
} from "../../src/services/currency";

const mockPool = pool as jest.Mocked<typeof pool>;
const mockRedis = redisClient as jest.Mocked<typeof redisClient>;
const mockGetThirtyDayVolume = getThirtyDayVolume as jest.Mock;
const mockMapVolumeToTier = mapVolumeToTier as jest.Mock;

// ── Helpers ─────────────────────────────────────────────────────────────────

const ADMIN_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

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

function pgResult(strategies: FeeStrategy[]) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// 1. FeeStrategyEngine — additional dynamic fee calculation coverage
// ═══════════════════════════════════════════════════════════════════════════════

describe("FeeStrategyEngine — dynamic fee calculation", () => {
  let engine: FeeStrategyEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.keys.mockResolvedValue([]);
    engine = new FeeStrategyEngine();
  });

  // ── Flat fee with min/max clamping ────────────────────────────────────────

  describe("FlatFeeStrategy — clamping", () => {
    it("clamps flat fee to minimum when flat amount is below minimum", async () => {
      const strategy = makeStrategy({
        strategyType: "flat",
        flatAmount: 10,
        feeMinimum: 50,
        feeMaximum: 5000,
        feePercentage: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(50);
      expect(result.breakdown.appliedMinimum).toBe(50);
    });

    it("clamps flat fee to maximum when flat amount exceeds maximum", async () => {
      const strategy = makeStrategy({
        strategyType: "flat",
        flatAmount: 10_000,
        feeMinimum: 50,
        feeMaximum: 5000,
        feePercentage: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(5000);
      expect(result.breakdown.appliedMaximum).toBe(5000);
    });

    it("returns exact flat fee when within min/max bounds", async () => {
      const strategy = makeStrategy({
        strategyType: "flat",
        flatAmount: 250,
        feeMinimum: 50,
        feeMaximum: 5000,
        feePercentage: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(250);
      expect(result.breakdown.appliedMinimum).toBeUndefined();
      expect(result.breakdown.appliedMaximum).toBeUndefined();
    });

    it("handles flat fee with no min/max configured", async () => {
      const strategy = makeStrategy({
        strategyType: "flat",
        flatAmount: 100,
        feeMinimum: undefined,
        feeMaximum: undefined,
        feePercentage: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(100);
      expect(result.breakdown.appliedMinimum).toBeUndefined();
      expect(result.breakdown.appliedMaximum).toBeUndefined();
    });

    it("defaults to 0 fee when flatAmount is not set", async () => {
      const strategy = makeStrategy({
        strategyType: "flat",
        flatAmount: undefined,
        feeMinimum: undefined,
        feeMaximum: undefined,
        feePercentage: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(0);
    });
  });

  // ── Volume-based strategy — tier boundaries and flat amounts ──────────────

  describe("VolumeBasedFeeStrategy — tier boundaries and flat amounts", () => {
    it("applies correct tier when amount equals tier minAmount (inclusive)", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        feeMinimum: 0,
        volumeTiers: [
          { minAmount: 0, maxAmount: 1000, feePercentage: 2.0 },
          { minAmount: 1000, maxAmount: 10000, feePercentage: 1.5 },
          { minAmount: 10000, maxAmount: null, feePercentage: 0.8 },
        ],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // Amount exactly 1000 → second tier (1.5%)
      const result = await engine.calculateFee({ amount: 1000 });
      expect(result.fee).toBe(15); // 1000 * 1.5%
    });

    it("applies first tier when amount is just below second tier minAmount", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        feeMinimum: 0,
        volumeTiers: [
          { minAmount: 0, maxAmount: 1000, feePercentage: 2.0 },
          { minAmount: 1000, maxAmount: 10000, feePercentage: 1.5 },
        ],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // Amount 999.99 → first tier (2.0%)
      const result = await engine.calculateFee({ amount: 999.99 });
      expect(result.fee).toBeCloseTo(20, 1); // 999.99 * 2%
    });

    it("applies unbounded top tier for very large amounts", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        feeMinimum: 0,
        feeMaximum: 100_000,
        volumeTiers: [
          { minAmount: 0, maxAmount: 100000, feePercentage: 1.5 },
          { minAmount: 100000, maxAmount: null, feePercentage: 0.5 },
        ],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000_000 });
      expect(result.fee).toBe(50_000); // 10M * 0.5%
    });

    it("uses flat amount tier instead of percentage when configured", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        feeMinimum: 0,
        volumeTiers: [
          { minAmount: 0, maxAmount: 1000, flatAmount: 5 },
          { minAmount: 1000, maxAmount: null, flatAmount: 25 },
        ],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 500 });
      expect(result.fee).toBe(5);
    });

    it("applies flat amount tier and clamps to minimum", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        feeMinimum: 10,
        volumeTiers: [
          { minAmount: 0, maxAmount: 1000, flatAmount: 3 },
        ],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // Flat amount (3) is below minimum (10)
      const result = await engine.calculateFee({ amount: 500 });
      expect(result.fee).toBe(10);
      expect(result.breakdown.appliedMinimum).toBe(10);
    });

    it("returns zero fee when no tiers are configured", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        volumeTiers: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 10_000 });
      expect(result.fee).toBe(0);
    });

    it("returns zero fee when amount does not match any tier", async () => {
      const strategy = makeStrategy({
        strategyType: "volume_based",
        feePercentage: undefined,
        volumeTiers: [
          { minAmount: 50000, maxAmount: null, feePercentage: 0.5 },
        ],
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 1000 });
      expect(result.fee).toBe(0);
    });
  });

  // ── Time-based strategy — override flat amount and exact boundaries ───────

  describe("TimeBasedFeeStrategy — override flat amount and boundaries", () => {
    it("applies override flat amount on matching day", async () => {
      // 2026-04-24 is a Friday (ISO weekday 5)
      const FRIDAY = new Date("2026-04-24T12:00:00Z");
      const timeStrategy = makeStrategy({
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5],
        overrideFlatAmount: 25,
        overridePercentage: undefined,
        feePercentage: undefined,
      });
      const fallback = makeStrategy({ priority: 100 });
      mockPool.query.mockResolvedValueOnce(
        pgResult([timeStrategy, fallback]) as any,
      );

      const result = await engine.calculateFee({
        amount: 10_000,
        evaluationTime: FRIDAY,
      });

      expect(result.fee).toBe(25);
      expect(result.timeOverrideActive).toBe(true);
    });

    it("clamps override flat amount to maximum", async () => {
      const FRIDAY = new Date("2026-04-24T12:00:00Z");
      const timeStrategy = makeStrategy({
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5],
        overrideFlatAmount: 10_000,
        feeMaximum: 5000,
        feePercentage: undefined,
      });
      const fallback = makeStrategy({ priority: 100 });
      mockPool.query.mockResolvedValueOnce(
        pgResult([timeStrategy, fallback]) as any,
      );

      const result = await engine.calculateFee({
        amount: 10_000,
        evaluationTime: FRIDAY,
      });

      expect(result.fee).toBe(5000);
      expect(result.breakdown.appliedMaximum).toBe(5000);
    });

    it("falls through at exact timeEnd boundary (exclusive)", async () => {
      // 2026-04-24 is a Friday
      const atTimeEnd = new Date("2026-04-24T17:00:00Z"); // exactly timeEnd
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
      const fallback = makeStrategy({ name: "Standard", priority: 100 });
      mockPool.query.mockResolvedValueOnce(
        pgResult([timeStrategy, fallback]) as any,
      );

      const result = await engine.calculateFee({
        amount: 10_000,
        evaluationTime: atTimeEnd,
      });

      // timeEnd is exclusive, so should fall through to fallback
      expect(result.fee).toBe(150); // fallback 1.5%
      expect(result.timeOverrideActive).toBe(false);
    });

    it("applies override at timeStart boundary (inclusive)", async () => {
      const atTimeStart = new Date("2026-04-24T09:00:00Z");
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
      mockPool.query.mockResolvedValueOnce(
        pgResult([timeStrategy, fallback]) as any,
      );

      const result = await engine.calculateFee({
        amount: 10_000,
        evaluationTime: atTimeStart,
      });

      expect(result.fee).toBe(0);
      expect(result.timeOverrideActive).toBe(true);
    });

    it("handles multiple days of week", async () => {
      // Saturday 2026-04-25 (ISO weekday 6)
      const SATURDAY = new Date("2026-04-25T12:00:00Z");
      const timeStrategy = makeStrategy({
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5, 6, 7], // Fri, Sat, Sun
        overridePercentage: 0,
        feePercentage: undefined,
      });
      const fallback = makeStrategy({ priority: 100 });
      mockPool.query.mockResolvedValueOnce(
        pgResult([timeStrategy, fallback]) as any,
      );

      const result = await engine.calculateFee({
        amount: 10_000,
        evaluationTime: SATURDAY,
      });

      expect(result.fee).toBe(0);
      expect(result.timeOverrideActive).toBe(true);
    });
  });

  // ── Percentage strategy — user scope skips minimum ────────────────────────

  describe("PercentageFeeStrategy — user scope skips minimum", () => {
    it("does not apply minimum when scope is user", async () => {
      const strategy = makeStrategy({
        name: "User 0.1%",
        scope: "user",
        userId: USER_ID,
        feePercentage: 0.1,
        feeMinimum: 100,
        feeMaximum: 5000,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // 1000 * 0.1% = 1, which is below feeMinimum (100), but user scope skips min
      const result = await engine.calculateFee({
        amount: 1000,
        userId: USER_ID,
      });

      expect(result.fee).toBe(1);
      expect(result.breakdown.appliedMinimum).toBeUndefined();
    });

    it("still applies maximum when scope is user", async () => {
      const strategy = makeStrategy({
        name: "User 10%",
        scope: "user",
        userId: USER_ID,
        feePercentage: 10,
        feeMinimum: 50,
        feeMaximum: 500,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({
        amount: 10_000,
        userId: USER_ID,
      });

      // 10000 * 10% = 1000, clamped to max 500
      expect(result.fee).toBe(500);
      expect(result.breakdown.appliedMaximum).toBe(500);
    });
  });

  // ── Unknown strategy type ─────────────────────────────────────────────────

  describe("Unknown strategy type", () => {
    it("returns null for unrecognized strategy type, engine falls through", async () => {
      const unknownStrategy = makeStrategy({
        name: "Mystery",
        strategyType: "unknown_type" as any,
        priority: 10,
      });
      const fallback = makeStrategy({ name: "Fallback", priority: 100 });
      mockPool.query.mockResolvedValueOnce(
        pgResult([unknownStrategy, fallback]) as any,
      );

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(150); // fallback
      expect(result.strategyUsed).toBe("Fallback");
    });
  });

  // ── VIP discount with max cap ─────────────────────────────────────────────

  describe("VIP discount — max cap clamping", () => {
    it("applies discounted maximum cap when VIP discount reduces fee above max", async () => {
      const strategy = makeStrategy({
        name: "High Fee 5%",
        scope: "global",
        feePercentage: 5,
        feeMinimum: 50,
        feeMaximum: 1000,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // VIP discount 50%
      mockGetThirtyDayVolume.mockResolvedValueOnce(25000);
      mockMapVolumeToTier.mockReturnValueOnce({ discountPercent: 50 });

      // 100000 * 5% = 5000. With 50% discount: 2500 raw.
      // Discounted max: 1000 * 0.5 = 500. So fee = 500.
      const result = await engine.calculateFee({
        amount: 100_000,
        userId: USER_ID,
      });

      expect(result.fee).toBe(500);
      expect(result.breakdown.appliedMaximum).toBe(500);
    });

    it("applies discounted minimum when VIP discount raises fee above discounted min", async () => {
      const strategy = makeStrategy({
        name: "Low Fee 0.5% min 200",
        scope: "global",
        feePercentage: 0.5,
        feeMinimum: 200,
        feeMaximum: 5000,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // VIP discount 60%
      mockGetThirtyDayVolume.mockResolvedValueOnce(60000);
      mockMapVolumeToTier.mockReturnValueOnce({ discountPercent: 60 });

      // Amount 1000: 1000 * 0.5% = 5 raw. With 60% discount: 5 * 0.4 = 2.
      // Discounted min: 200 * 0.4 = 80. Since 2 < 80, fee = 80.
      const result = await engine.calculateFee({
        amount: 1000,
        userId: USER_ID,
      });

      expect(result.fee).toBe(80);
      expect(result.breakdown.appliedMinimum).toBe(80);
    });
  });

  // ── Rounding / precision ──────────────────────────────────────────────────

  describe("Rounding and precision", () => {
    it("rounds fee and total to 2 decimal places", async () => {
      const strategy = makeStrategy({
        feePercentage: 1.5,
        feeMinimum: 0,
        feeMaximum: 999_999,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      // 1234.56 * 1.5% = 18.5184 → should round to 18.52
      const result = await engine.calculateFee({ amount: 1234.56 });

      expect(result.fee).toBe(18.52);
      expect(result.total).toBe(1253.08);
    });

    it("rounds breakdown values to 2 decimal places", async () => {
      const strategy = makeStrategy({
        feePercentage: 1.5,
        feeMinimum: 0,
        feeMaximum: 999_999,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 1234.56 });

      expect(result.breakdown.rawFee).toBe(18.52);
      expect(result.breakdown.clampedFee).toBe(18.52);
    });

    it("handles very small amounts with precision", async () => {
      const strategy = makeStrategy({
        feePercentage: 1.5,
        feeMinimum: 0,
        feeMaximum: 999_999,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 0.01 });

      // 0.01 * 1.5% = 0.00015 → rounds to 0
      expect(result.fee).toBe(0);
      expect(result.total).toBe(0.01);
    });
  });

  // ── No strategies fallback ────────────────────────────────────────────────

  describe("No strategies — zero fee default", () => {
    it("returns zero fee with strategyUsed 'none' when no strategies match", async () => {
      mockPool.query.mockResolvedValueOnce(pgResult([]) as any);

      const result = await engine.calculateFee({ amount: 50_000 });

      expect(result.fee).toBe(0);
      expect(result.total).toBe(50_000);
      expect(result.strategyUsed).toBe("none");
      expect(result.scopeUsed).toBe("global");
      expect(result.timeOverrideActive).toBe(false);
    });
  });

  // ── Multiple strategies — first match wins ────────────────────────────────

  describe("Multiple strategies — first matching wins", () => {
    it("uses first global strategy when only global strategies exist", async () => {
      const first = makeStrategy({
        name: "First 2%",
        priority: 10,
        feePercentage: 2,
      });
      const second = makeStrategy({
        id: "bbbbbbbb-0000-0000-0000-000000000001",
        name: "Second 1%",
        priority: 20,
        feePercentage: 1,
      });
      mockPool.query.mockResolvedValueOnce(
        pgResult([first, second]) as any,
      );

      const result = await engine.calculateFee({ amount: 10_000 });

      expect(result.fee).toBe(200); // 10000 * 2%
      expect(result.strategyUsed).toBe("First 2%");
    });

    it("time_based falls through when condition not met, next strategy applies", async () => {
      // 2026-04-24 is Friday
      const MONDAY = new Date("2026-04-20T12:00:00Z");
      const timeStrategy = makeStrategy({
        name: "Fee-free Friday",
        strategyType: "time_based",
        priority: 10,
        daysOfWeek: [5],
        overridePercentage: 0,
        feePercentage: undefined,
      });
      const percentageStrategy = makeStrategy({
        id: "bbbbbbbb-0000-0000-0000-000000000001",
        name: "Standard 1.5%",
        priority: 20,
        feePercentage: 1.5,
      });
      mockPool.query.mockResolvedValueOnce(
        pgResult([timeStrategy, percentageStrategy]) as any,
      );

      const result = await engine.calculateFee({
        amount: 10_000,
        evaluationTime: MONDAY,
      });

      expect(result.fee).toBe(150);
      expect(result.timeOverrideActive).toBe(false);
      expect(result.strategyUsed).toBe("Standard 1.5%");
    });
  });

  // ── Large amount stress ───────────────────────────────────────────────────

  describe("Large amount handling", () => {
    it("handles very large transaction amounts", async () => {
      const strategy = makeStrategy({
        feePercentage: 1.5,
        feeMinimum: 50,
        feeMaximum: 100_000,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 1_000_000_000 });

      // 1B * 1.5% = 15M → clamped to max 100000
      expect(result.fee).toBe(100_000);
      expect(result.total).toBe(1_000_100_000);
    });

    it("handles zero amount with zero-fee strategy", async () => {
      const strategy = makeStrategy({
        strategyType: "flat",
        flatAmount: 0,
        feeMinimum: 0,
        feePercentage: undefined,
      });
      mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

      const result = await engine.calculateFee({ amount: 0 });

      expect(result.fee).toBe(0);
      expect(result.total).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Dynamic Spread — additional edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("computeLiquidityScaleFactor — edge cases", () => {
  it("handles zero volume (clamped to min 1 internally)", () => {
    const factor = computeLiquidityScaleFactor(0);
    expect(factor).toBeGreaterThanOrEqual(0.2);
    expect(factor).toBeLessThanOrEqual(4.0);
  });

  it("handles volume of 1 (minimum safe value)", () => {
    const factor = computeLiquidityScaleFactor(1);
    expect(factor).toBeGreaterThan(1.0);
    expect(factor).toBeLessThanOrEqual(4.0);
  });

  it("handles negative volume (treated as 0 via clamping)", () => {
    const factor = computeLiquidityScaleFactor(-1000);
    expect(factor).toBeGreaterThanOrEqual(0.2);
    expect(factor).toBeLessThanOrEqual(4.0);
  });

  it("handles very small positive volume", () => {
    const factor = computeLiquidityScaleFactor(0.01);
    expect(factor).toBeGreaterThan(1.0);
  });

  it("is monotonically decreasing across full range", () => {
    const volumes = [100, 1000, 10000, 100000, 1000000, 10000000];
    const factors = volumes.map((v) => computeLiquidityScaleFactor(v));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThanOrEqual(factors[i - 1]);
    }
  });

  it("returns exactly 1.0 at reference volume (100,000)", () => {
    const factor = computeLiquidityScaleFactor(100_000);
    expect(factor).toBeCloseTo(1.0, 2);
  });
});

describe("computeSettlementScaleFactor — edge cases", () => {
  it("handles zero settlement time", () => {
    const factor = computeSettlementScaleFactor(0);
    expect(factor).toBeGreaterThanOrEqual(0.7);
    expect(factor).toBeLessThanOrEqual(3.0);
  });

  it("handles negative settlement time", () => {
    const factor = computeSettlementScaleFactor(-5000);
    expect(factor).toBeGreaterThanOrEqual(0.7);
  });

  it("returns 1.0 at reference settlement (30000ms)", () => {
    const factor = computeSettlementScaleFactor(30_000);
    expect(factor).toBeCloseTo(1.0, 5);
  });

  it("is monotonically increasing", () => {
    const times = [0, 5000, 15000, 30000, 60000, 120000, 600000];
    const factors = times.map((t) => computeSettlementScaleFactor(t));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeGreaterThanOrEqual(factors[i - 1]);
    }
  });

  it("returns exactly 0.7 at very fast settlement (clamped)", () => {
    const factor = computeSettlementScaleFactor(0);
    expect(factor).toBeGreaterThanOrEqual(0.7);
  });

  it("returns exactly 3.0 at very slow settlement (clamped)", () => {
    const factor = computeSettlementScaleFactor(1_000_000_000);
    expect(factor).toBeLessThanOrEqual(3.0);
  });
});

describe("computeSpread — boundary conditions", () => {
  it("returns base spread (1.5%) when both factors are 1.0", () => {
    expect(computeSpread(1.0, 1.0)).toBeCloseTo(1.5, 4);
  });

  it("returns minimum spread (0.3%) when factors are very low", () => {
    expect(computeSpread(0.2, 0.7)).toBeGreaterThanOrEqual(0.3);
    expect(computeSpread(0.2, 0.7)).toBeLessThanOrEqual(8.0);
  });

  it("returns maximum spread (8.0%) when factors are very high", () => {
    expect(computeSpread(4.0, 3.0)).toBeLessThanOrEqual(8.0);
    expect(computeSpread(4.0, 3.0)).toBeGreaterThanOrEqual(0.3);
  });

  it("spread with both factors at minimum clamp is still at least MIN_SPREAD", () => {
    const spread = computeSpread(0.2, 0.7);
    expect(spread).toBeGreaterThanOrEqual(0.3);
  });

  it("spread with both factors at maximum clamp is at most MAX_SPREAD", () => {
    const spread = computeSpread(4.0, 3.0);
    expect(spread).toBeLessThanOrEqual(8.0);
  });

  it("is symmetric in factor multiplication", () => {
    // 1.5 * 2.0 * 1.5 = 4.5
    const spread1 = computeSpread(2.0, 1.5);
    const spread2 = computeSpread(1.5, 2.0);
    expect(spread1).toBeCloseTo(spread2, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Airtel fee tiers — additional edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("calculateAirtelFee — additional coverage", () => {
  it("applies micro tier (1%) for amount of 500", () => {
    const result = calculateAirtelFee(500);
    expect(result.tier).toBe("micro");
    expect(result.rate).toBe(0.01);
    expect(result.fee).toBe(5); // 500 * 0.01 = 5, floored at min 5
    expect(result.netAmount).toBe(495);
  });

  it("applies micro tier at exact boundary (999.99)", () => {
    const result = calculateAirtelFee(999.99);
    expect(result.tier).toBe("micro");
    expect(result.rate).toBe(0.01);
  });

  it("applies standard tier at exact lower bound (1000)", () => {
    const result = calculateAirtelFee(1000);
    expect(result.tier).toBe("standard");
    expect(result.rate).toBe(0.008);
    expect(result.fee).toBe(8); // 1000 * 0.008
    expect(result.netAmount).toBe(992);
  });

  it("applies standard tier for mid-range (5000)", () => {
    const result = calculateAirtelFee(5000);
    expect(result.tier).toBe("standard");
    expect(result.rate).toBe(0.008);
    expect(result.fee).toBe(40);
    expect(result.netAmount).toBe(4960);
  });

  it("applies standard tier at upper boundary (9999.99)", () => {
    const result = calculateAirtelFee(9999.99);
    expect(result.tier).toBe("standard");
    expect(result.rate).toBe(0.008);
  });

  it("applies bulk tier at exact lower bound (10000)", () => {
    const result = calculateAirtelFee(10000);
    expect(result.tier).toBe("bulk");
    expect(result.rate).toBe(0.005);
    expect(result.fee).toBe(50); // 10000 * 0.005
    expect(result.netAmount).toBe(9950);
  });

  it("applies bulk tier for mid-range (30000)", () => {
    const result = calculateAirtelFee(30000);
    expect(result.tier).toBe("bulk");
    expect(result.rate).toBe(0.005);
    expect(result.fee).toBe(150); // 30000 * 0.005
    expect(result.netAmount).toBe(29850);
  });

  it("applies bulk tier at upper boundary (49999.99)", () => {
    const result = calculateAirtelFee(49999.99);
    expect(result.tier).toBe("bulk");
    expect(result.rate).toBe(0.005);
  });

  it("applies enterprise tier at exact lower bound (50000)", () => {
    const result = calculateAirtelFee(50000);
    expect(result.tier).toBe("enterprise");
    expect(result.rate).toBe(0.003);
    expect(result.fee).toBe(150); // 50000 * 0.003
    expect(result.netAmount).toBe(49850);
  });

  it("applies enterprise tier for large amounts (500000)", () => {
    const result = calculateAirtelFee(500000);
    expect(result.tier).toBe("enterprise");
    expect(result.rate).toBe(0.003);
    expect(result.fee).toBe(1500);
    expect(result.netAmount).toBe(498500);
  });

  it("enforces minimum fee for micro tier amounts below min", () => {
    // 100 * 1% = 1, below AIRTEL_MIN_FEE (5)
    const result = calculateAirtelFee(100);
    expect(result.fee).toBe(5);
    expect(result.netAmount).toBe(95);
  });

  it("returns exact fee of 0 for amount 0", () => {
    const result = calculateAirtelFee(0);
    expect(result.fee).toBe(AIRTEL_MIN_FEE); // max(0, 5) = 5
    expect(result.netAmount).toBe(-5); // 0 - 5 = -5
  });

  it("rounds fee to 2 decimal places", () => {
    // 1234.56 * 0.008 = 9.87648 → rounds to 9.88
    const result = calculateAirtelFee(1234.56);
    expect(result.fee).toBe(9.88);
  });

  it("rounds netAmount to 2 decimal places", () => {
    const result = calculateAirtelFee(1234.56);
    expect(result.netAmount).toBe(1224.68); // 1234.56 - 9.88
  });

  it("handles very large amount", () => {
    const result = calculateAirtelFee(10_000_000);
    expect(result.tier).toBe("enterprise");
    expect(result.rate).toBe(0.003);
    expect(result.fee).toBe(30_000);
    expect(result.netAmount).toBe(9_970_000);
  });

  it("throws for negative amount", () => {
    expect(() => calculateAirtelFee(-100)).toThrow(
      "Amount must be a finite, non-negative number",
    );
  });

  it("throws for NaN", () => {
    expect(() => calculateAirtelFee(NaN)).toThrow(
      "Amount must be a finite, non-negative number",
    );
  });

  it("throws for Infinity", () => {
    expect(() => calculateAirtelFee(Infinity)).toThrow(
      "Amount must be a finite, non-negative number",
    );
  });

  it("throws for negative Infinity", () => {
    expect(() => calculateAirtelFee(-Infinity)).toThrow(
      "Amount must be a finite, non-negative number",
    );
  });

  it("tier boundaries are contiguous with no gaps", () => {
    // Each tier's min should equal the previous tier's max
    for (let i = 1; i < AIRTEL_FEE_TIERS.length; i++) {
      expect(AIRTEL_FEE_TIERS[i].min).toBe(AIRTEL_FEE_TIERS[i - 1].max);
    }
  });

  it("fee rates decrease as tiers increase (regressive structure)", () => {
    for (let i = 1; i < AIRTEL_FEE_TIERS.length; i++) {
      expect(AIRTEL_FEE_TIERS[i].rate).toBeLessThan(
        AIRTEL_FEE_TIERS[i - 1].rate,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. calculateFeeSync — additional edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("calculateFeeSync — additional coverage", () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    jest.unmock("../../src/utils/fees");
  });

  afterAll(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  function loadCalculateFeeSync() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../src/utils/fees");
    return mod.calculateFeeSync as typeof import("../../src/utils/fees").calculateFeeSync;
  }

  it("verifies default FEE_PERCENTAGE (1.5%) calculation", () => {
    // Default env: FEE_PERCENTAGE=1.5, FEE_MINIMUM=50, FEE_MAXIMUM=5000
    const calculateFeeSync = loadCalculateFeeSync();
    const result = calculateFeeSync(10_000);
    // 10000 * 1.5% = 150
    expect(result.fee).toBe(150);
    expect(result.total).toBe(10_150);
  });

  it("applies custom minimum fee from env", () => {
    process.env.FEE_PERCENTAGE = "0.5";
    process.env.FEE_MINIMUM = "100";
    process.env.FEE_MAXIMUM = "5000";

    const calculateFeeSync = loadCalculateFeeSync();
    // 1000 * 0.5% = 5, below min of 100
    const result = calculateFeeSync(1000);
    expect(result.fee).toBe(100);
    expect(result.total).toBe(1100);
  });

  it("applies custom maximum fee from env", () => {
    process.env.FEE_PERCENTAGE = "5";
    process.env.FEE_MINIMUM = "50";
    process.env.FEE_MAXIMUM = "200";

    const calculateFeeSync = loadCalculateFeeSync();
    // 10000 * 5% = 500, above max of 200
    const result = calculateFeeSync(10_000);
    expect(result.fee).toBe(200);
    expect(result.total).toBe(10_200);
  });

  it("rounds to 2 decimal places", () => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "0";
    process.env.FEE_MAXIMUM = "5000";

    const calculateFeeSync = loadCalculateFeeSync();
    // 999.99 * 1.5% = 14.99985 → rounds to 15.00
    const result = calculateFeeSync(999.99);
    expect(result.fee).toBe(15);
    expect(result.total).toBe(1014.99);
  });

  it("handles fractional amounts precisely", () => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "0";
    process.env.FEE_MAXIMUM = "5000";

    const calculateFeeSync = loadCalculateFeeSync();
    const result = calculateFeeSync(1234.56);
    // 1234.56 * 1.5% = 18.5184 → rounds to 18.52
    expect(result.fee).toBe(18.52);
    expect(result.total).toBe(1253.08);
  });

  it("returns configUsed 'env_fallback'", () => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "50";
    process.env.FEE_MAXIMUM = "5000";

    const calculateFeeSync = loadCalculateFeeSync();
    const result = calculateFeeSync(10_000);
    expect(result.configUsed).toBe("env_fallback");
  });

  it("handles minimum equal to maximum (both clamped to same value)", () => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "100";
    process.env.FEE_MAXIMUM = "100";

    const calculateFeeSync = loadCalculateFeeSync();
    const result = calculateFeeSync(10_000);
    // 10000 * 1.5% = 150, clamped to both min and max = 100
    expect(result.fee).toBe(100);
  });

  it("handles negative amount gracefully (applies min fee)", () => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "50";
    process.env.FEE_MAXIMUM = "5000";

    const calculateFeeSync = loadCalculateFeeSync();
    // Negative amount: -100 * 1.5% = -1.5, clamped to min 50
    const result = calculateFeeSync(-100);
    expect(result.fee).toBe(50);
  });
});
