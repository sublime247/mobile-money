/**
 * Unit tests for the Tiered VIP Fee System (src/utils/fees.ts)
 *
 * Covers:
 *  - mapVolumeToTier: pure mapping function
 *  - getThirtyDayVolume: DB query with Redis cache
 *  - calculateFeeForUser: end-to-end discounted fee calculation per tier
 */

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use these modules
// ---------------------------------------------------------------------------

jest.mock("../../src/config/database");
jest.mock("../../src/config/redis");
jest.mock("../../src/services/feeService");

import { pool } from "../../src/config/database";
import { redisClient } from "../../src/config/redis";
import { feeService } from "../../src/services/feeService";
import {
  VipTier,
  VIP_TIERS,
  mapVolumeToTier,
  getThirtyDayVolume,
  calculateFeeForUser,
} from "../../src/utils/fees";

const mockPool = pool as jest.Mocked<typeof pool>;
const mockRedis = redisClient as jest.Mocked<typeof redisClient>;
const mockFeeService = feeService as jest.Mocked<typeof feeService>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRedisEmpty() {
  mockRedis.get.mockResolvedValue(null);
  mockRedis.setEx.mockResolvedValue("OK");
}

function mockRedisValue(value: string) {
  mockRedis.get.mockResolvedValue(value);
}

function mockDbVolume(volume: number) {
  (mockPool.query as jest.Mock).mockResolvedValue({
    rows: [{ volume: String(volume) }],
  });
}

function mockActiveConfig(feePercentage = 1.5, feeMinimum = 50, feeMaximum = 5000) {
  mockFeeService.getActiveConfiguration.mockResolvedValue({
    id: "cfg-1",
    name: "default",
    feePercentage,
    feeMinimum,
    feeMaximum,
    isActive: true,
    createdBy: "system",
    updatedBy: "system",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// mapVolumeToTier — pure function tests
// ---------------------------------------------------------------------------

describe("mapVolumeToTier", () => {
  const cases: [number, VipTier][] = [
    [0,      VipTier.STANDARD],
    [999,    VipTier.STANDARD],
    [1000,   VipTier.SILVER],
    [4999,   VipTier.SILVER],
    [5000,   VipTier.GOLD],
    [19999,  VipTier.GOLD],
    [20000,  VipTier.PLATINUM],
    [49999,  VipTier.PLATINUM],
    [50000,  VipTier.DIAMOND],
    [999999, VipTier.DIAMOND],
  ];

  test.each(cases)("volume %i → %s", (volume, expected) => {
    expect(mapVolumeToTier(volume).tier).toBe(expected);
  });

  it("returns correct discountPercent for each tier", () => {
    expect(mapVolumeToTier(0).discountPercent).toBe(0);
    expect(mapVolumeToTier(1000).discountPercent).toBe(20);
    expect(mapVolumeToTier(5000).discountPercent).toBe(35);
    expect(mapVolumeToTier(20000).discountPercent).toBe(50);
    expect(mapVolumeToTier(50000).discountPercent).toBe(65);
  });

  it("VIP_TIERS cover the full range with no gaps at boundaries", () => {
    // Every tier threshold should map to that exact tier
    VIP_TIERS.forEach((t) => {
      expect(mapVolumeToTier(t.minVolume).tier).toBe(t.tier);
    });
  });
});

// ---------------------------------------------------------------------------
// getThirtyDayVolume — DB + cache
// ---------------------------------------------------------------------------

describe("getThirtyDayVolume", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns cached value from Redis without hitting the DB", async () => {
    mockRedisValue("12345.67");

    const volume = await getThirtyDayVolume("user-1");

    expect(volume).toBeCloseTo(12345.67);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("queries the DB when cache miss and caches the result", async () => {
    mockRedisEmpty();
    mockDbVolume(8000);

    const volume = await getThirtyDayVolume("user-1");

    expect(volume).toBe(8000);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockRedis.setEx).toHaveBeenCalledWith(
      "vip_volume:user-1",
      300,
      "8000",
    );
  });

  it("returns 0 when user has no completed transactions", async () => {
    mockRedisEmpty();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ volume: "0" }] });

    const volume = await getThirtyDayVolume("user-new");

    expect(volume).toBe(0);
  });

  it("falls back gracefully when Redis throws", async () => {
    mockRedis.get.mockRejectedValue(new Error("Redis down"));
    mockRedis.setEx.mockRejectedValue(new Error("Redis down"));
    mockDbVolume(5500);

    const volume = await getThirtyDayVolume("user-1");

    expect(volume).toBe(5500);
  });
});

// ---------------------------------------------------------------------------
// calculateFeeForUser — end-to-end per tier
// ---------------------------------------------------------------------------

describe("calculateFeeForUser", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisEmpty();
    mockActiveConfig(); // 1.5% base, min 50, max 5000
  });

  it("STANDARD tier: no discount, applies full 1.5% rate", async () => {
    mockDbVolume(500); // < 1000 → STANDARD

    const result = await calculateFeeForUser(10000, "user-1");

    expect(result.tier).toBe(VipTier.STANDARD);
    expect(result.discountPercent).toBe(0);
    // 10000 * 1.5% = 150
    expect(result.fee).toBe(150);
    expect(result.total).toBe(10150);
    expect(result.thirtyDayVolume).toBe(500);
    expect(result.configUsed).toBe("default");
  });

  it("SILVER tier: 20% discount → effective rate 1.2%", async () => {
    mockDbVolume(2500); // SILVER

    const result = await calculateFeeForUser(10000, "user-2");

    expect(result.tier).toBe(VipTier.SILVER);
    expect(result.discountPercent).toBe(20);
    // 10000 * (1.5 * 0.8)% = 10000 * 1.2% = 120
    expect(result.fee).toBe(120);
    expect(result.total).toBe(10120);
  });

  it("GOLD tier: 35% discount → effective rate 0.975%", async () => {
    mockDbVolume(10000); // GOLD

    const result = await calculateFeeForUser(10000, "user-3");

    expect(result.tier).toBe(VipTier.GOLD);
    expect(result.discountPercent).toBe(35);
    // 10000 * (1.5 * 0.65)% = 10000 * 0.975% = 97.5
    expect(result.fee).toBe(97.5);
    expect(result.total).toBe(10097.5);
  });

  it("PLATINUM tier: 50% discount → effective rate 0.75%", async () => {
    mockDbVolume(25000); // PLATINUM

    const result = await calculateFeeForUser(10000, "user-4");

    expect(result.tier).toBe(VipTier.PLATINUM);
    expect(result.discountPercent).toBe(50);
    // 10000 * 0.75% = 75
    expect(result.fee).toBe(75);
    expect(result.total).toBe(10075);
  });

  it("DIAMOND tier: 65% discount → effective rate 0.525%", async () => {
    mockDbVolume(60000); // DIAMOND

    const result = await calculateFeeForUser(50000, "user-5");

    expect(result.tier).toBe(VipTier.DIAMOND);
    expect(result.discountPercent).toBe(65);
    // 50000 * (1.5 * 0.35)% = 50000 * 0.525% = 262.5
    expect(result.fee).toBe(262.5);
    expect(result.total).toBe(50262.5);
  });

  it("applies discounted minimum floor when fee would be too small", async () => {
    mockDbVolume(60000); // DIAMOND — 65% off
    // min = 50, discounted min = 50 * 0.35 = 17.5
    // fee on amount 100 = 100 * 0.525% = 0.525 → clamps to 17.5
    const result = await calculateFeeForUser(100, "user-6");

    expect(result.tier).toBe(VipTier.DIAMOND);
    expect(result.fee).toBe(17.5);
    expect(result.total).toBe(117.5);
  });

  it("applies discounted maximum cap when fee would be too large", async () => {
    mockDbVolume(50000); // DIAMOND
    mockActiveConfig(1.5, 50, 5000);
    // max = 5000, discounted max = 5000 * 0.35 = 1750
    // fee on amount 10_000_000 = 10_000_000 * 0.525% = 52500 → clamps to 1750
    const result = await calculateFeeForUser(10_000_000, "user-7");

    expect(result.fee).toBe(1750);
    expect(result.total).toBe(10_001_750);
  });

  it("falls back to env vars when feeService.getActiveConfiguration throws", async () => {
    mockDbVolume(1500); // SILVER
    mockFeeService.getActiveConfiguration.mockRejectedValue(
      new Error("DB unavailable"),
    );

    // env fallback: FEE_PERCENTAGE=1.5, FEE_MINIMUM=50, FEE_MAXIMUM=5000
    const result = await calculateFeeForUser(10000, "user-8");

    expect(result.tier).toBe(VipTier.SILVER);
    expect(result.discountPercent).toBe(20);
    expect(result.configUsed).toBe("env_fallback");
    // 10000 * 1.2% = 120
    expect(result.fee).toBe(120);
  });

  it("recalculates accurately on different volumes for same user", async () => {
    // First call: volume in SILVER range
    mockRedisEmpty();
    mockDbVolume(3000);
    mockActiveConfig();

    const silverResult = await calculateFeeForUser(10000, "user-9");
    expect(silverResult.tier).toBe(VipTier.SILVER);

    // Simulate cache expiry: next call with higher volume → GOLD
    jest.clearAllMocks();
    mockRedisEmpty();
    mockDbVolume(8000);
    mockActiveConfig();

    const goldResult = await calculateFeeForUser(10000, "user-9");
    expect(goldResult.tier).toBe(VipTier.GOLD);
    expect(goldResult.fee).toBeLessThan(silverResult.fee);
  });
});
