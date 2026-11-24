import {
  computeFullJitterDelay,
  exponentialCeiling,
} from "../jitterBackoff";

jest.mock("../logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from "../logger";
import {
  DEFAULT_WEBHOOK_RETRY_ATTEMPTS,
  DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS,
  DEFAULT_WEBHOOK_RETRY_MAX_DELAY_MS,
  WEBHOOK_BACKOFF_TYPE,
  buildWebhookRetryJobOptions,
  createWebhookBackoffStrategy,
  getWebhookRetryConfig,
} from "../../queue/webhookQueue";

const opts = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

/** Deterministic PRNG (mulberry32) so distribution tests never flake. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("exponentialCeiling", () => {
  it("doubles the base delay per attempt", () => {
    expect([0, 1, 2, 3, 4].map((a) => exponentialCeiling(a, opts))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it("is capped at maxDelayMs", () => {
    expect(exponentialCeiling(6, opts)).toBe(60_000); // 64s → 60s
    expect(exponentialCeiling(30, opts)).toBe(60_000);
  });

  it("does not overflow for huge attempt counts", () => {
    expect(exponentialCeiling(5_000, opts)).toBe(60_000);
  });

  it("clamps negative and non-finite attempts to 0", () => {
    expect(exponentialCeiling(-3, opts)).toBe(1_000);
    expect(exponentialCeiling(Number.NaN, opts)).toBe(1_000);
  });

  it("rejects invalid options", () => {
    expect(() => exponentialCeiling(1, { baseDelayMs: -1, maxDelayMs: 10 })).toThrow(
      RangeError,
    );
    expect(() =>
      exponentialCeiling(1, { baseDelayMs: 1, maxDelayMs: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });
});

describe("computeFullJitterDelay", () => {
  it("returns 0 at the low end of the random range", () => {
    expect(computeFullJitterDelay(3, opts, () => 0)).toBe(0);
  });

  it("never exceeds the ceiling, even at the top of the random range", () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = exponentialCeiling(attempt, opts);
      expect(computeFullJitterDelay(attempt, opts, () => 0.999999999)).toBeLessThanOrEqual(
        ceiling,
      );
      // A misbehaving RNG returning >= 1 is clamped too.
      expect(computeFullJitterDelay(attempt, opts, () => 1.5)).toBe(ceiling);
    }
  });

  it("never exceeds maxDelayMs for any attempt", () => {
    const random = seeded(42);
    for (let i = 0; i < 5_000; i++) {
      const attempt = i % 40;
      const delay = computeFullJitterDelay(attempt, opts, random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(opts.maxDelayMs);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  it("spreads delays uniformly across [0, ceiling]", () => {
    const random = seeded(2563);
    const attempt = 4; // ceiling = 16_000ms
    const ceiling = exponentialCeiling(attempt, opts);
    const samples = 20_000;
    const buckets = new Array(10).fill(0);
    let sum = 0;

    for (let i = 0; i < samples; i++) {
      const delay = computeFullJitterDelay(attempt, opts, random);
      sum += delay;
      buckets[Math.min(9, Math.floor((delay / (ceiling + 1)) * 10))]++;
    }

    // Mean of U(0, ceiling) is ceiling / 2.
    expect(sum / samples).toBeGreaterThan(ceiling * 0.47);
    expect(sum / samples).toBeLessThan(ceiling * 0.53);
    // Each decile holds ~10% of samples — no clustering at the ceiling.
    for (const count of buckets) {
      expect(count / samples).toBeGreaterThan(0.085);
      expect(count / samples).toBeLessThan(0.115);
    }
  });

  it("produces distinct delays for concurrent retries (no thundering herd)", () => {
    const random = seeded(7);
    const delays = new Set(
      Array.from({ length: 100 }, () => computeFullJitterDelay(5, opts, random)),
    );
    expect(delays.size).toBeGreaterThan(90);
  });
});

describe("webhook queue retry configuration", () => {
  beforeEach(() => jest.clearAllMocks());

  it("defaults to 8 attempts that settle within 24 hours", () => {
    const config = getWebhookRetryConfig({});
    expect(config).toEqual({
      attempts: DEFAULT_WEBHOOK_RETRY_ATTEMPTS,
      baseDelayMs: DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_WEBHOOK_RETRY_MAX_DELAY_MS,
    });
    expect(config.attempts).toBe(8);

    // Worst case: every retry waits its full ceiling (attemptsMade = 1..7).
    let worstCase = 0;
    for (let attempt = 1; attempt < config.attempts; attempt++) {
      worstCase += exponentialCeiling(attempt, config);
    }
    expect(worstCase).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("reads attempts and delays from the environment", () => {
    expect(
      getWebhookRetryConfig({
        WEBHOOK_RETRY_MAX_ATTEMPTS: "3",
        WEBHOOK_RETRY_BASE_DELAY_MS: "100",
        WEBHOOK_RETRY_MAX_DELAY_MS: "5000",
      }),
    ).toEqual({ attempts: 3, baseDelayMs: 100, maxDelayMs: 5000 });
  });

  it("falls back to defaults for invalid values and keeps max >= base", () => {
    const config = getWebhookRetryConfig({
      WEBHOOK_RETRY_MAX_ATTEMPTS: "0",
      WEBHOOK_RETRY_BASE_DELAY_MS: "abc",
      WEBHOOK_RETRY_MAX_DELAY_MS: "1",
    });
    expect(config.attempts).toBe(DEFAULT_WEBHOOK_RETRY_ATTEMPTS);
    expect(config.baseDelayMs).toBe(DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS);
    expect(config.maxDelayMs).toBe(DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS);
  });

  it("builds BullMQ job options using the custom backoff type", () => {
    expect(
      buildWebhookRetryJobOptions({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 }),
    ).toEqual({ attempts: 5, backoff: { type: WEBHOOK_BACKOFF_TYPE } });
  });

  it("backoff strategy returns the jittered delay and records an audit entry", async () => {
    const strategy = createWebhookBackoffStrategy(
      { attempts: 8, ...opts },
      () => 0.5,
    );
    const job = {
      id: "job-9",
      data: { webhookId: "tx-1", eventType: "transaction.completed" },
      opts: { attempts: 8 },
      log: jest.fn().mockResolvedValue(1),
    };

    const delay = await strategy(3, WEBHOOK_BACKOFF_TYPE, new Error("HTTP 503"), job as any);

    expect(delay).toBe(4_000); // floor(0.5 * (8_000 + 1))
    const expected = {
      jobId: "job-9",
      webhookId: "tx-1",
      eventType: "transaction.completed",
      attempt: 3,
      maxAttempts: 8,
      delayMs: 4_000,
      ceilingMs: 8_000,
      error: "HTTP 503",
    };
    expect(logger.info).toHaveBeenCalledWith(expected, expect.any(String));
    expect(job.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(job.log.mock.calls[0][0])).toEqual({
      type: "retry_scheduled",
      ...expected,
    });
  });

  it("backoff strategy tolerates a missing job", () => {
    const strategy = createWebhookBackoffStrategy({ attempts: 8, ...opts }, () => 0);
    expect(strategy(1)).toBe(0);
  });
});
