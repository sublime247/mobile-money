/**
 * Unit & integration tests for the dynamic spread algorithm and rate controller.
 * Issue #1631 – dynamic spread scaling based on liquidity depth & settlement time.
 */

import {
  computeLiquidityScaleFactor,
  computeSettlementScaleFactor,
  computeSpread,
  DynamicSpreadService,
  SpreadInputs,
} from "../../services/dynamicSpreadService";
import { rateController } from "../rateController";
import { AIRTEL_FEE_TIERS } from "../../services/currency";

// ─────────────────────────────────────────────────────────────────────────────
// Mock heavy dependencies so tests run without DB / Redis
// ─────────────────────────────────────────────────────────────────────────────

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ volume: "250000" }] }),
  },
}));

jest.mock("../../services/providerSettingsService", () => ({
  providerSettingsService: {
    getProviderSettings: jest.fn().mockResolvedValue({
      provider_name: "mtn",
      failure_threshold: 5,
      timeout_ms: 30000, // 30 s reference settlement
      fallback_order: null,
    }),
  },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure algorithm unit tests (no I/O)
// ─────────────────────────────────────────────────────────────────────────────

describe("computeLiquidityScaleFactor()", () => {
  it("returns ≈ 1.0 at the reference volume (100 000 USD)", () => {
    const factor = computeLiquidityScaleFactor(100_000);
    expect(factor).toBeCloseTo(1.0, 2);
  });

  it("returns > 1.0 (wider spread) when volume is below reference", () => {
    const lowFactor = computeLiquidityScaleFactor(1_000); // illiquid
    expect(lowFactor).toBeGreaterThan(1.0);
  });

  it("returns < 1.0 (tighter spread) when volume is well above reference", () => {
    const highFactor = computeLiquidityScaleFactor(10_000_000); // very liquid
    expect(highFactor).toBeLessThan(1.0);
  });

  it("clamps the factor to a minimum of 0.2 (never eliminates spread entirely)", () => {
    const hugeVolume = computeLiquidityScaleFactor(Number.MAX_SAFE_INTEGER);
    expect(hugeVolume).toBeGreaterThanOrEqual(0.2);
  });

  it("clamps the factor to a maximum of 4.0 (protects from infinite widening)", () => {
    const zeroVolume = computeLiquidityScaleFactor(0);
    expect(zeroVolume).toBeLessThanOrEqual(4.0);
  });

  it("is monotonically decreasing: higher volume → smaller factor", () => {
    const f1 = computeLiquidityScaleFactor(10_000);
    const f2 = computeLiquidityScaleFactor(100_000);
    const f3 = computeLiquidityScaleFactor(1_000_000);
    expect(f1).toBeGreaterThan(f2);
    expect(f2).toBeGreaterThan(f3);
  });
});

describe("computeSettlementScaleFactor()", () => {
  const REFERENCE = 30_000; // 30 s

  it("returns 1.0 at the reference settlement time", () => {
    const factor = computeSettlementScaleFactor(REFERENCE);
    expect(factor).toBeCloseTo(1.0, 5);
  });

  it("returns < 1.0 (tighter spread) for faster-than-reference settlement", () => {
    const fastFactor = computeSettlementScaleFactor(5_000); // 5 s
    expect(fastFactor).toBeLessThan(1.0);
  });

  it("returns > 1.0 (wider spread) for slower-than-reference settlement", () => {
    const slowFactor = computeSettlementScaleFactor(300_000); // 5 min
    expect(slowFactor).toBeGreaterThan(1.0);
  });

  it("clamps factor to minimum 0.7 (discount floor)", () => {
    const instant = computeSettlementScaleFactor(0);
    expect(instant).toBeGreaterThanOrEqual(0.7);
  });

  it("clamps factor to maximum 3.0 (penalty ceiling)", () => {
    const veryLong = computeSettlementScaleFactor(1_000_000_000); // 11 days
    expect(veryLong).toBeLessThanOrEqual(3.0);
  });

  it("is monotonically increasing: longer settlement → larger factor", () => {
    const f1 = computeSettlementScaleFactor(5_000);
    const f2 = computeSettlementScaleFactor(30_000);
    const f3 = computeSettlementScaleFactor(120_000);
    expect(f1).toBeLessThan(f2);
    expect(f2).toBeLessThan(f3);
  });
});

describe("computeSpread()", () => {
  it("produces the base spread (1.5%) when both factors equal 1.0", () => {
    const spread = computeSpread(1.0, 1.0);
    expect(spread).toBeCloseTo(1.5, 4);
  });

  it("respects the minimum spread floor (0.3%)", () => {
    const spread = computeSpread(0.01, 0.01); // extreme discount factors
    expect(spread).toBeGreaterThanOrEqual(0.3);
  });

  it("respects the maximum spread ceiling (8.0%)", () => {
    const spread = computeSpread(4.0, 3.0); // max both factors
    expect(spread).toBeLessThanOrEqual(8.0);
  });

  it("scales up spread when liquidity is low and settlement is slow", () => {
    const tightMarket = computeSpread(2.5, 2.0); // illiquid, slow
    const normalMarket = computeSpread(1.0, 1.0);
    expect(tightMarket).toBeGreaterThan(normalMarket);
  });

  it("scales down spread when liquidity is high and settlement is fast", () => {
    const liquidMarket = computeSpread(0.5, 0.8); // liquid, fast
    const normalMarket = computeSpread(1.0, 1.0);
    expect(liquidMarket).toBeLessThan(normalMarket);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DynamicSpreadService integration tests (mocked DB + providerSettings)
// ─────────────────────────────────────────────────────────────────────────────

describe("DynamicSpreadService.calculateSpread()", () => {
  const service = new DynamicSpreadService();
  const RAW_RATE = 1550; // NGN/USD
  const inputs: SpreadInputs = {
    provider: "mtn",
    fromCurrency: "NGN",
    toCurrency: "USD",
  };

  it("returns a valid SpreadResult with all required fields", async () => {
    const result = await service.calculateSpread(RAW_RATE, inputs);

    expect(result).toMatchObject({
      spreadPct: expect.any(Number),
      rawRate: RAW_RATE,
      adjustedRate: expect.any(Number),
      provider: "mtn",
      currencyPair: "NGN_USD",
      direction: "sell",
      calculatedAt: expect.any(String),
      breakdown: {
        baseSpreadPct: expect.any(Number),
        liquidityVolumeUsd: expect.any(Number),
        liquidityScaleFactor: expect.any(Number),
        settlementTimeMs: expect.any(Number),
        settlementScaleFactor: expect.any(Number),
      },
    });
  });

  it("sell direction: adjustedRate < rawRate (platform takes a cut)", async () => {
    const result = await service.calculateSpread(RAW_RATE, inputs, "sell");
    expect(result.adjustedRate).toBeLessThan(result.rawRate);
  });

  it("buy direction: adjustedRate > rawRate (user pays more)", async () => {
    const result = await service.calculateSpread(RAW_RATE, inputs, "buy");
    expect(result.adjustedRate).toBeGreaterThan(result.rawRate);
  });

  it("respects liquidityVolumeUsd override (high volume → tighter spread)", async () => {
    const [lowLiq, highLiq] = await Promise.all([
      service.calculateSpread(RAW_RATE, { ...inputs, liquidityVolumeUsd: 500 }),
      service.calculateSpread(RAW_RATE, {
        ...inputs,
        liquidityVolumeUsd: 5_000_000,
      }),
    ]);
    expect(lowLiq.spreadPct).toBeGreaterThan(highLiq.spreadPct);
  });

  it("respects settlementTimeMs override (slow settlement → wider spread)", async () => {
    const [fast, slow] = await Promise.all([
      service.calculateSpread(RAW_RATE, { ...inputs, settlementTimeMs: 5_000 }),
      service.calculateSpread(RAW_RATE, {
        ...inputs,
        settlementTimeMs: 600_000,
      }),
    ]);
    expect(slow.spreadPct).toBeGreaterThan(fast.spreadPct);
  });

  it("spreadPct is always within [MIN_SPREAD, MAX_SPREAD] bounds", async () => {
    const scenarios = [
      { liquidityVolumeUsd: 0, settlementTimeMs: 0 },
      { liquidityVolumeUsd: 0, settlementTimeMs: 9_000_000 },
      { liquidityVolumeUsd: 1e12, settlementTimeMs: 0 },
      { liquidityVolumeUsd: 1e12, settlementTimeMs: 9_000_000 },
      { liquidityVolumeUsd: 100_000, settlementTimeMs: 30_000 },
    ];

    for (const overrides of scenarios) {
      const result = await service.calculateSpread(RAW_RATE, {
        ...inputs,
        ...overrides,
      });
      expect(result.spreadPct).toBeGreaterThanOrEqual(0.3);
      expect(result.spreadPct).toBeLessThanOrEqual(8.0);
    }
  });
});

describe("DynamicSpreadService.getSpreadParameters()", () => {
  const service = new DynamicSpreadService();

  it("returns all required parameter fields", async () => {
    const params = await service.getSpreadParameters("airtel");

    expect(params).toMatchObject({
      provider: "airtel",
      baseSpreadPct: expect.any(Number),
      liquidityVolumeUsd: expect.any(Number),
      liquidityScaleFactor: expect.any(Number),
      settlementTimeMs: expect.any(Number),
      settlementScaleFactor: expect.any(Number),
      effectiveSpreadPct: expect.any(Number),
      minSpreadPct: 0.3,
      maxSpreadPct: 8.0,
    });
  });

  it("uses provided overrides instead of querying DB", async () => {
    const params = await service.getSpreadParameters(
      "orange",
      999_999, // explicit volume
      45_000,  // explicit settlement time
    );

    expect(params.liquidityVolumeUsd).toBe(999_999);
    expect(params.settlementTimeMs).toBe(45_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Airtel Money tiered transaction fee calculation (#1552)
// ─────────────────────────────────────────────────────────────────────────────

describe("RateController.calculateAirtelFeeQuote()", () => {
  function mockRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  it("applies the micro tier (1%) for small amounts, floored at the minimum fee", () => {
    const res = mockRes();
    rateController.calculateAirtelFeeQuote({ body: { amount: 100 } } as any, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        grossAmount: 100,
        fee: 5, // 1% of 100 = 1, floored at AIRTEL_MIN_FEE (5)
        netAmount: 95,
        tier: "micro",
        rate: 0.01,
      },
    });
  });

  it("applies the standard tier (0.8%) for mid-range amounts", () => {
    const res = mockRes();
    rateController.calculateAirtelFeeQuote({ body: { amount: 5000 } } as any, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.tier).toBe("standard");
    expect(data.fee).toBe(40); // 5000 * 0.008
    expect(data.netAmount).toBe(4960);
  });

  it("applies the enterprise tier (0.3%) for large amounts", () => {
    const res = mockRes();
    rateController.calculateAirtelFeeQuote({ body: { amount: 100_000 } } as any, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.tier).toBe("enterprise");
    expect(data.fee).toBe(300); // 100000 * 0.003
    expect(data.netAmount).toBe(99_700);
  });

  it("returns 400 when amount is missing", () => {
    const res = mockRes();
    rateController.calculateAirtelFeeQuote({ body: {} } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("returns 400 when amount is negative", () => {
    const res = mockRes();
    rateController.calculateAirtelFeeQuote(
      { body: { amount: -50 } } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("RateController.getAirtelFeeTiers()", () => {
  it("returns the full tiered fee schedule", () => {
    const res: any = { json: jest.fn() };
    rateController.getAirtelFeeTiers({} as any, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { tiers: AIRTEL_FEE_TIERS },
    });
  });
});
