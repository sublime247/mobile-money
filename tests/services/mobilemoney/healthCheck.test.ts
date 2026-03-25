/**
 * src/services/mobilemoney/healthCheck.test.ts
 *
 * Run:  npm test  (or npm run test:watch for watch mode)
 *
 * Coverage target: ≥70% branches / functions / lines / statements
 * (matches the project-wide threshold in jest.config.ts)
 */

import {
  checkMobileMoneyHealth,
  pingProvider,
  ProviderConfig,
  MobileMoneyHealthResult,
  _clearCache,
  _resetCircuits,
  _inProcessCache,
  _circuitMap,
} from "../../../src/services/mobilemoney/providers/healthCheck";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MTN: ProviderConfig = {
  name: "mtn",
  pingUrl: "https://test.local/mtn",
  timeoutMs: 300,
};
const AIRTEL: ProviderConfig = {
  name: "airtel",
  pingUrl: "https://test.local/airtel",
  timeoutMs: 300,
};
const ORANGE: ProviderConfig = {
  name: "orange",
  pingUrl: "https://test.local/orange",
  timeoutMs: 300,
};
const ALL = [MTN, AIRTEL, ORANGE];

// ─── Fake fetch factories ─────────────────────────────────────────────────────

/** Returns a fetch that immediately resolves with the given HTTP status. */
function fakeFetch(status: number): typeof fetch {
  return async () =>
    ({ ok: status >= 200 && status < 300, status }) as Response;
}

/** Returns a fetch that rejects with a network error. */
function failingFetch(message = "ECONNREFUSED"): typeof fetch {
  return async () => {
    throw new Error(message);
  };
}

/**
 * Returns a fetch that stalls until the AbortSignal fires, then rejects.
 * Simulates a timeout cleanly without using real timers.
 */
function hangingFetch(): typeof fetch {
  return async (_url, init) => {
    await new Promise<void>((_res, rej) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        signal.addEventListener("abort", () =>
          rej(new DOMException("The user aborted a request.", "AbortError")),
        );
      }
    });
    return {} as Response; // unreachable
  };
}

/** Counts how many times fetch is called, wraps another fetch impl. */
function countingFetch(inner: typeof fetch): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let n = 0;
  return {
    fetch: async (url, init) => {
      n++;
      return inner(url, init);
    },
    calls: () => n,
  };
}

// ─── Reset state between every test ──────────────────────────────────────────

beforeEach(() => {
  _clearCache();
  _resetCircuits();
  // Ensure REDIS_URL is absent so we stay in in-process cache mode
  delete process.env.REDIS_URL;
});

// ═════════════════════════════════════════════════════════════════════════════
// pingProvider()
// ═════════════════════════════════════════════════════════════════════════════

describe("pingProvider()", () => {
  // ── Happy paths ─────────────────────────────────────────────────────────────

  it("returns status=up and a non-negative responseTime for HTTP 200", async () => {
    const result = await pingProvider(MTN, fakeFetch(200));
    expect(result.status).toBe("up");
    expect(typeof result.responseTime).toBe("number");
    expect(result.responseTime).toBeGreaterThanOrEqual(0);
  });

  it("returns status=up for HTTP 301 (redirect — gateway reachable)", async () => {
    const result = await pingProvider(MTN, fakeFetch(301));
    expect(result.status).toBe("up");
  });

  it("returns status=up for HTTP 401 (auth needed but endpoint alive)", async () => {
    const result = await pingProvider(MTN, fakeFetch(401));
    expect(result.status).toBe("up");
  });

  it("returns status=up for HTTP 404 (wrong path but server alive)", async () => {
    const result = await pingProvider(MTN, fakeFetch(404));
    expect(result.status).toBe("up");
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it("returns status=down for HTTP 500", async () => {
    const result = await pingProvider(MTN, fakeFetch(500));
    expect(result.status).toBe("down");
  });

  it("returns status=down for HTTP 503", async () => {
    const result = await pingProvider(MTN, fakeFetch(503));
    expect(result.status).toBe("down");
  });

  it("returns status=down and responseTime=null on network error", async () => {
    const result = await pingProvider(MTN, failingFetch());
    expect(result.status).toBe("down");
    expect(result.responseTime).toBeNull();
  });

  it("returns status=down and responseTime=null on timeout", async () => {
    const fast: ProviderConfig = { ...MTN, timeoutMs: 50 };
    const result = await pingProvider(fast, hangingFetch());
    expect(result.status).toBe("down");
    expect(result.responseTime).toBeNull();
  }, 5_000);

  // ── Never throws ────────────────────────────────────────────────────────────

  it("never rejects even when fetch throws a non-Error", async () => {
    const weirdFetch: typeof fetch = async () => {
      throw "string error";
    };
    await expect(pingProvider(MTN, weirdFetch)).resolves.toMatchObject({
      status: "down",
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Circuit breaker (via pingProvider)
// ═════════════════════════════════════════════════════════════════════════════

describe("Circuit breaker", () => {
  it("opens the circuit after 3 consecutive failures", async () => {
    // Three failures open the circuit
    for (let i = 0; i < 3; i++) {
      await pingProvider(MTN, failingFetch());
    }
    const state = _circuitMap.get("mtn");
    expect(state?.openUntil).toBeGreaterThan(Date.now());
  });

  it("returns down immediately (without calling fetch) while circuit is open", async () => {
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await pingProvider(MTN, failingFetch());
    }

    const { fetch: spy, calls } = countingFetch(fakeFetch(200));
    const result = await pingProvider(MTN, spy);

    expect(result.status).toBe("down");
    expect(calls()).toBe(0); // no network call made
  });

  it("does not open the circuit on intermittent failures below threshold", async () => {
    await pingProvider(MTN, failingFetch()); // fail 1
    await pingProvider(MTN, fakeFetch(200)); // success — resets counter
    await pingProvider(MTN, failingFetch()); // fail 1 again

    const state = _circuitMap.get("mtn");
    expect(state?.openUntil).toBe(0); // still closed
  });

  it("resets the failure counter on success", async () => {
    await pingProvider(MTN, failingFetch());
    await pingProvider(MTN, failingFetch());
    await pingProvider(MTN, fakeFetch(200)); // success
    const state = _circuitMap.get("mtn");
    expect(state?.failures).toBe(0);
    expect(state?.openUntil).toBe(0);
  });

  it("isolates circuit state per provider", async () => {
    // Open MTN's circuit
    for (let i = 0; i < 3; i++) await pingProvider(MTN, failingFetch());

    // Airtel should still work
    const result = await pingProvider(AIRTEL, fakeFetch(200));
    expect(result.status).toBe("up");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// checkMobileMoneyHealth()
// ═════════════════════════════════════════════════════════════════════════════

describe("checkMobileMoneyHealth()", () => {
  // ── Response shape ──────────────────────────────────────────────────────────

  it("includes a key for every configured provider", async () => {
    const result = await checkMobileMoneyHealth(ALL, fakeFetch(200));
    expect(Object.keys(result.providers).sort()).toEqual([
      "airtel",
      "mtn",
      "orange",
    ]);
  });

  it("matches the documented response shape (all up)", async () => {
    const result = await checkMobileMoneyHealth(ALL, fakeFetch(200));
    for (const health of Object.values(result.providers)) {
      expect(health).toMatchObject({ status: "up" });
      expect(typeof health.responseTime).toBe("number");
    }
  });

  it("matches the documented response shape with a downed provider", async () => {
    // orange is down; mtn and airtel are up
    const mixedFetch: typeof fetch = async (url, init) => {
      if (String(url).includes("orange")) throw new Error("no route");
      return fakeFetch(200)(url, init);
    };

    const result = await checkMobileMoneyHealth(ALL, mixedFetch);

    expect(result).toMatchObject<MobileMoneyHealthResult>({
      providers: {
        mtn: { status: "up", responseTime: expect.any(Number) },
        airtel: { status: "up", responseTime: expect.any(Number) },
        orange: { status: "down", responseTime: null },
      },
    });
  });

  // ── Safety guarantees ────────────────────────────────────────────────────────

  it("never rejects when all providers fail", async () => {
    await expect(
      checkMobileMoneyHealth(ALL, failingFetch()),
    ).resolves.toBeDefined();
  });

  it("never rejects when fetch throws a non-standard value", async () => {
    const weirdFetch: typeof fetch = async () => {
      throw 42;
    };
    await expect(
      checkMobileMoneyHealth(ALL, weirdFetch),
    ).resolves.toBeDefined();
  });

  // ── Caching (in-process) ────────────────────────────────────────────────────

  it("serves the second call from cache without hitting the network", async () => {
    const { fetch: spy, calls } = countingFetch(fakeFetch(200));

    await checkMobileMoneyHealth([MTN], spy); // populates cache
    await checkMobileMoneyHealth([MTN], spy); // should hit cache

    expect(calls()).toBe(1);
  });

  it("re-fetches after the cache is explicitly cleared", async () => {
    const { fetch: spy, calls } = countingFetch(fakeFetch(200));

    await checkMobileMoneyHealth([MTN], spy);
    _clearCache();
    await checkMobileMoneyHealth([MTN], spy);

    expect(calls()).toBe(2);
  });

  it("re-fetches after the in-process cache has expired", async () => {
    const { fetch: spy, calls } = countingFetch(fakeFetch(200));

    await checkMobileMoneyHealth([MTN], spy);
    // Manually expire the cache
    _inProcessCache.expiresAt = Date.now() - 1;
    await checkMobileMoneyHealth([MTN], spy);

    expect(calls()).toBe(2);
  });

  it("returns the same object reference while the cache is hot", async () => {
    const first = await checkMobileMoneyHealth([MTN], fakeFetch(200));
    const second = await checkMobileMoneyHealth([MTN], fakeFetch(200));
    expect(first).toBe(second);
  });

  // ── Concurrency ─────────────────────────────────────────────────────────────

  it("pings all providers concurrently (does not serialise)", async () => {
    // Each provider takes ~50 ms; if serialised total ≥ 150 ms
    const delay = (ms: number): Promise<void> =>
      new Promise((r) => setTimeout(r, ms));

    const slowFetch: typeof fetch = async () => {
      await delay(50);
      return { ok: true, status: 200 } as Response;
    };

    const before = Date.now();
    await checkMobileMoneyHealth(ALL, slowFetch);
    const elapsed = Date.now() - before;

    // Concurrent: elapsed should be ~50 ms, not ~150 ms
    // We allow up to 130 ms to avoid flakiness in slow CI environments
    expect(elapsed).toBeLessThan(130);
  }, 10_000);

  // ── Single provider subset ───────────────────────────────────────────────────

  it("works correctly with a single-provider list", async () => {
    const result = await checkMobileMoneyHealth([AIRTEL], fakeFetch(200));
    expect(result.providers.airtel.status).toBe("up");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test helpers
// ═════════════════════════════════════════════════════════════════════════════

describe("_clearCache()", () => {
  it("removes in-process cached data", async () => {
    await checkMobileMoneyHealth([MTN], fakeFetch(200));
    expect(_inProcessCache.result).not.toBeNull();
    _clearCache();
    expect(_inProcessCache.result).toBeNull();
  });
});

describe("_resetCircuits()", () => {
  it("clears all circuit-breaker state", async () => {
    for (let i = 0; i < 3; i++) await pingProvider(MTN, failingFetch());
    expect(_circuitMap.size).toBeGreaterThan(0);
    _resetCircuits();
    expect(_circuitMap.size).toBe(0);
  });
});
