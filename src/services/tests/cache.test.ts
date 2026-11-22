import {
  fxCacheRequestsTotal,
  fxCacheHitRatio,
} from "../../monitoring/metrics";
import {
  recordFxCacheHit,
  recordFxCacheMiss,
  getFxCacheHitRatio,
  resetFxCacheMetrics,
  FxExchangeRateCacheManager,
  fxExchangeRateCacheManager,
} from "../cache";
import { register } from "../../utils/metrics";
import { layeredCache } from "../layeredCache";

jest.mock("../layeredCache", () => ({
  layeredCache: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    delPattern: jest.fn(),
  },
}));

describe("FX Cache Prometheus Metrics (#2505)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetFxCacheMetrics();
    fxCacheRequestsTotal.reset();
  });

  it("defines fx_cache_requests_total counter with result label", () => {
    expect(fxCacheRequestsTotal).toBeDefined();
    // @ts-ignore - inspect labelNames on prom-client counter
    expect((fxCacheRequestsTotal as any).labelNames).toContain("result");
  });

  it("defines fx_cache_hit_ratio gauge", () => {
    expect(fxCacheHitRatio).toBeDefined();
  });

  it("increments fx_cache_requests_total with result=hit and updates hit ratio", async () => {
    recordFxCacheHit();

    const metric = await fxCacheRequestsTotal.get();
    const hitValue = metric.values.find(
      (v) => v.labels.result === "hit",
    )?.value;
    expect(hitValue).toBe(1);

    expect(getFxCacheHitRatio()).toBe(1); // 1 hit / 1 total = 1.0

    const gaugeMetric = await fxCacheHitRatio.get();
    expect(gaugeMetric.values[0]?.value).toBe(1);
  });

  it("increments fx_cache_requests_total with result=miss and updates hit ratio", async () => {
    recordFxCacheMiss();

    const metric = await fxCacheRequestsTotal.get();
    const missValue = metric.values.find(
      (v) => v.labels.result === "miss",
    )?.value;
    expect(missValue).toBe(1);

    expect(getFxCacheHitRatio()).toBe(0); // 0 hits / 1 total = 0.0

    const gaugeMetric = await fxCacheHitRatio.get();
    expect(gaugeMetric.values[0]?.value).toBe(0);
  });

  it("correctly calculates cache hit ratio across multiple requests", async () => {
    // 3 hits, 1 miss => 3 / 4 = 0.75
    recordFxCacheHit();
    recordFxCacheHit();
    recordFxCacheHit();
    recordFxCacheMiss();

    const metric = await fxCacheRequestsTotal.get();
    const hitValue = metric.values.find(
      (v) => v.labels.result === "hit",
    )?.value;
    const missValue = metric.values.find(
      (v) => v.labels.result === "miss",
    )?.value;

    expect(hitValue).toBe(3);
    expect(missValue).toBe(1);
    expect(getFxCacheHitRatio()).toBe(0.75);

    const gaugeMetric = await fxCacheHitRatio.get();
    expect(gaugeMetric.values[0]?.value).toBe(0.75);
  });

  it("FxExchangeRateCacheManager increments hit and miss metrics on rate lookups", async () => {
    const manager = new FxExchangeRateCacheManager();

    // Cache hit
    (layeredCache.get as jest.Mock).mockResolvedValueOnce("655.957");
    const rateHit = await manager.getRate("EUR/XAF");
    expect(rateHit).toBe("655.957");
    expect(manager.getHitRatio()).toBe(1.0);

    // Cache miss
    (layeredCache.get as jest.Mock).mockResolvedValueOnce(null);
    const rateMiss = await manager.getRate("USD/KES");
    expect(rateMiss).toBeNull();
    expect(manager.getHitRatio()).toBe(0.5); // 1 hit, 1 miss = 0.5
  });

  it("exposes fx_cache_requests_total and fx_cache_hit_ratio on /metrics Prometheus output", async () => {
    recordFxCacheHit();
    recordFxCacheMiss();

    const metricsOutput = await register.metrics();
    expect(metricsOutput).toContain("fx_cache_requests_total");
    expect(metricsOutput).toContain('result="hit"');
    expect(metricsOutput).toContain('result="miss"');
    expect(metricsOutput).toContain("fx_cache_hit_ratio");
  });
});
