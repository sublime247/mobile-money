jest.mock("../../config/database", () => ({ queryRead: jest.fn() }));
jest.mock("../../config/redis", () => ({ redisClient: {} }));

import {
  DEFAULT_TIERS,
  SPREAD_CONFIG_KEY,
  clampSpread,
  computePairSpread,
  computeVolatilityStats,
  fetchPriceHistory,
  filterRollingWindow,
  getLiveSpreadBps,
  mapVolatilityToSpread,
  normalisePair,
  runVolatilityIndexing,
  selectTier,
  spreadPairKey,
  standardDeviation,
  type PriceHistorySource,
  type PriceTick,
  type SpreadRedis,
} from "../fxVolatilityService";

const NOW = new Date("2026-11-24T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const ticks = (prices: number[]): PriceTick[] =>
  prices.map((price, i) => ({ price, recordedAt: hoursAgo(prices.length - i) }));

function fakeRedis() {
  const store = new Map<string, string>();
  const execs: Array<Array<[string, string, unknown]>> = [];
  const redis: SpreadRedis = {
    multi() {
      const queued: Array<[string, string, unknown]> = [];
      const tx = {
        set(key: string, value: string, opts?: unknown) {
          queued.push([key, value, opts]);
          return tx;
        },
        async exec() {
          execs.push(queued);
          for (const [k, v] of queued) store.set(k, v);
          return queued.map(() => "OK");
        },
      };
      return tx;
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
  };
  return { redis, store, execs };
}

describe("standard deviation computation", () => {
  it("computes population standard deviation", () => {
    // mean 5, squared deviations sum 32, /8 = 4 -> sd 2
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  });

  it("is zero for constant series and fewer than two samples", () => {
    expect(standardDeviation([1500, 1500, 1500])).toBe(0);
    expect(standardDeviation([1500])).toBe(0);
    expect(standardDeviation([])).toBe(0);
  });

  it("normalises by the mean so pairs of different magnitude compare", () => {
    const ngn = computeVolatilityStats(ticks([1500, 1530, 1470, 1500]))!;
    const kes = computeVolatilityStats(ticks([130, 132.6, 127.4, 130]))!;
    expect(ngn.coefficientOfVariationPct).toBeCloseTo(kes.coefficientOfVariationPct, 6);
    expect(ngn.mean).toBe(1500);
    expect(ngn.sampleSize).toBe(4);
  });

  it("ignores non-positive / non-finite ticks and needs >= 2 samples", () => {
    expect(computeVolatilityStats(ticks([0, NaN, 1500]))).toBeNull();
    expect(computeVolatilityStats(ticks([-1, 100, 100]))!.stddev).toBe(0);
  });

  it("keeps only ticks inside the rolling window", () => {
    const series: PriceTick[] = [
      { price: 1, recordedAt: hoursAgo(25) },
      { price: 2, recordedAt: hoursAgo(23) },
      { price: 3, recordedAt: hoursAgo(1) },
    ];
    expect(filterRollingWindow(series, 24 * 3_600_000, NOW).map((t) => t.price)).toEqual([2, 3]);
  });
});

describe("volatility tiers and spread clamping", () => {
  const clamp = { minBps: 25, maxBps: 300 };

  it("maps volatility into tiers by upper bound", () => {
    expect(selectTier(0.1).name).toBe("LOW");
    expect(selectTier(0.5).name).toBe("MODERATE");
    expect(selectTier(2.9).name).toBe("HIGH");
    expect(selectTier(50).name).toBe("EXTREME");
  });

  it("clamps tier margins to the configured ceiling", () => {
    expect(mapVolatilityToSpread(10, DEFAULT_TIERS, clamp)).toEqual({
      tier: "EXTREME",
      spreadBps: 300,
    });
  });

  it("clamps tier margins to the configured floor", () => {
    const tiers = [{ name: "LOW" as const, maxVolatilityPct: Infinity, spreadBps: 5 }];
    expect(mapVolatilityToSpread(0.01, tiers, clamp).spreadBps).toBe(25);
  });

  it("clampSpread rounds and bounds, treating non-finite as max", () => {
    expect(clampSpread(123.6, clamp)).toBe(124);
    expect(clampSpread(-10, clamp)).toBe(25);
    expect(clampSpread(10_000, clamp)).toBe(300);
    expect(clampSpread(NaN, clamp)).toBe(300);
  });

  it("uses the default spread (clamped) when data is insufficient", () => {
    expect(mapVolatilityToSpread(null, DEFAULT_TIERS, clamp)).toEqual({
      tier: "INSUFFICIENT_DATA",
      spreadBps: 100,
    });
  });
});

describe("price history fetching", () => {
  it("normalises pair notation", () => {
    expect(normalisePair("ngn_usdc")).toBe("NGN/USDC");
    expect(() => normalisePair("NGN")).toThrow();
  });

  it("falls back to the inverse pair and inverts prices", async () => {
    const source: PriceHistorySource = jest.fn(async (b, q) =>
      b === "USDC" && q === "NGN" ? ticks([0.0005, 0.0004]) : [],
    );
    const result = await fetchPriceHistory("NGN/USDC", { now: NOW, source });
    expect(result.map((t) => t.price)).toEqual([2000, 2500]);
  });

  it("uses USD as a proxy for USDC when no USDC ticks exist", async () => {
    const source: PriceHistorySource = jest.fn(async (b, q) =>
      b === "KES" && q === "USD" ? ticks([130, 131]) : [],
    );
    const result = await fetchPriceHistory("KES/USDC", { now: NOW, source });
    expect(result).toHaveLength(2);
    expect(source).toHaveBeenCalledWith("KES", "USD", hoursAgo(24), NOW);
  });
});

describe("runVolatilityIndexing", () => {
  const source: PriceHistorySource = async (base) => {
    if (base === "NGN") return ticks([1500, 1600, 1400, 1700, 1300]); // very volatile
    if (base === "KES") return ticks([130, 130.1, 129.9, 130]); // calm
    return [];
  };

  it("computes per-pair spreads and writes them atomically in one MULTI", async () => {
    const { redis, store, execs } = fakeRedis();
    const snapshot = await runVolatilityIndexing({
      pairs: ["NGN/USDC", "KES/USDC", "GHS/USDC"],
      now: NOW,
      source,
      redis,
      clamp: { minBps: 25, maxBps: 500 },
    });

    expect(snapshot.pairs["NGN/USDC"].tier).toBe("EXTREME");
    expect(snapshot.pairs["NGN/USDC"].spreadBps).toBe(400);
    expect(snapshot.pairs["KES/USDC"].tier).toBe("LOW");
    expect(snapshot.pairs["KES/USDC"].spreadBps).toBe(50);
    expect(snapshot.pairs["GHS/USDC"].tier).toBe("INSUFFICIENT_DATA");

    expect(execs).toHaveLength(1);
    const keys = execs[0].map(([k]) => k);
    expect(keys).toEqual([
      SPREAD_CONFIG_KEY,
      spreadPairKey("NGN/USDC"),
      spreadPairKey("KES/USDC"),
      spreadPairKey("GHS/USDC"),
    ]);
    for (const [, , opts] of execs[0]) expect(opts).toEqual({ EX: expect.any(Number) });

    expect(JSON.parse(store.get(SPREAD_CONFIG_KEY)!).pairs["KES/USDC"].spreadBps).toBe(50);
    await expect(getLiveSpreadBps("ngn_usdc", redis)).resolves.toBe(400);
  });

  it("skips a failing pair without aborting the snapshot", async () => {
    const { redis } = fakeRedis();
    const flaky: PriceHistorySource = async (base) => {
      if (base === "NGN") throw new Error("db timeout");
      return source(base, "USDC", hoursAgo(24), NOW);
    };
    const snapshot = await runVolatilityIndexing({
      pairs: ["NGN/USDC", "KES/USDC"],
      now: NOW,
      source: flaky,
      redis,
    });
    expect(Object.keys(snapshot.pairs)).toEqual(["KES/USDC"]);
  });

  it("returns null for unknown pairs when reading the live spread", async () => {
    const { redis } = fakeRedis();
    await expect(getLiveSpreadBps("ZAR/USDC", redis)).resolves.toBeNull();
  });

  it("computePairSpread reports stddev and sample size", async () => {
    const spread = await computePairSpread("KES/USDC", { now: NOW, source });
    expect(spread.sampleSize).toBe(4);
    expect(spread.stddev).toBeCloseTo(standardDeviation([130, 130.1, 129.9, 130]), 10);
  });
});
