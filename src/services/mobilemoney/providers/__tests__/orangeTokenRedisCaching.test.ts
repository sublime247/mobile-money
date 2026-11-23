/**
 * Integration tests for OrangeProvider's Redis-backed token caching (#2273).
 *
 * Exercises the real OrangeProvider.authenticateDirect()/requestDirect()
 * flow end-to-end against a fake Redis and a fake HTTP client, rather than
 * only unit-testing OrangeTokenCache in isolation
 * (orangeTokenCache.test.ts), so a regression in the wiring between the two
 * (not just the cache module itself) would also be caught.
 */

interface FakeRedisEntry {
  value: string;
  expiresAt: number | null;
}

const fakeStore = new Map<string, FakeRedisEntry>();

const fakeRedisClient = {
  get: jest.fn(async (key: string) => {
    const entry = fakeStore.get(key);
    if (!entry) return null;
    return entry.value;
  }),
  set: jest.fn(
    async (
      key: string,
      value: string,
      opts?: { expiration?: { type: string; value: number } },
    ) => {
      fakeStore.set(key, {
        value,
        expiresAt: opts?.expiration ? Date.now() + opts.expiration.value : null,
      });
      return "OK";
    },
  ),
  del: jest.fn(async (key: string) => {
    return fakeStore.delete(key) ? 1 : 0;
  }),
};

jest.mock("../../../../config/redis", () => ({
  redisClient: fakeRedisClient,
}));

// `orange.requestTimeoutMs` is not a registered convict schema key (only
// `orangeCameroon.*` exists in src/config/appConfig.ts), so the real
// getConfigValue("orange.requestTimeoutMs") call in OrangeProvider's
// buildConfig() throws "cannot find configuration param" for EVERY
// OrangeProvider instantiation - a pre-existing bug unrelated to #2273's
// Redis-caching scope, confirmed by no other test in this repo ever
// instantiating OrangeProvider directly. Mocked narrowly here so this
// caching behavior is still exercised end-to-end without expanding this
// issue into an appConfig.ts schema fix.
jest.mock("../../../../config/appConfig", () => ({
  getConfigValue: jest.fn(() => undefined),
}));

import { OrangeProvider } from "../orange";

function makeDirectHttpClient(
  handler: (config: {
    method?: string;
    url?: string;
    data?: unknown;
  }) => { status: number; data: unknown },
) {
  return {
    request: jest.fn(async (config: any) => handler(config)),
  };
}

describe("OrangeProvider direct-mode Redis token caching (#2273)", () => {
  const env = { ...process.env };

  beforeEach(() => {
    fakeStore.clear();
    jest.clearAllMocks();
    process.env = { ...env };
    process.env.ORANGE_API_KEY = "orange-key";
    process.env.ORANGE_API_SECRET = "orange-secret";
    process.env.ORANGE_MODE = "direct";
  });

  afterAll(() => {
    process.env = env;
  });

  it("reuses the cached token across two provider instances (simulating two worker processes) instead of re-authenticating", async () => {
    let tokenFetchCount = 0;

    const directHttpClient = makeDirectHttpClient((config) => {
      if (String(config.url).includes("/oauth/token")) {
        tokenFetchCount += 1;
        return {
          status: 200,
          data: { access_token: "shared-process-token", expires_in: 3600 },
        };
      }
      return { status: 200, data: { ok: true } };
    });

    // First "process": a provider instance that authenticates and caches.
    const providerA = new OrangeProvider({
      mode: "direct",
      directHttpClient,
    });
    await providerA.requestPayment("+22507000000", "1000", "req-1");
    expect(tokenFetchCount).toBe(1);

    // Second "process": a brand-new OrangeProvider instance (same env/creds,
    // so the same Redis cache key), backed by the SAME fake Redis store but
    // otherwise independent in-process state. It must reuse the cached
    // token rather than hitting /oauth/token again.
    const providerB = new OrangeProvider({
      mode: "direct",
      directHttpClient,
    });
    await providerB.requestPayment("+22507000001", "2000", "req-2");

    expect(tokenFetchCount).toBe(1);
    expect(fakeRedisClient.get).toHaveBeenCalled();
  });

  it("invalidates the cache and retries exactly once on a 401, then succeeds with the fresh token", async () => {
    let tokenFetchCount = 0;
    let paymentAttempts = 0;

    const directHttpClient = makeDirectHttpClient((config) => {
      if (String(config.url).includes("/oauth/token")) {
        tokenFetchCount += 1;
        return {
          status: 200,
          data: {
            access_token: `token-${tokenFetchCount}`,
            expires_in: 3600,
          },
        };
      }

      // Payment endpoint: reject the first token with 401, accept the
      // second (post-invalidation) token.
      paymentAttempts += 1;
      if (paymentAttempts === 1) {
        return { status: 401, data: { error: "invalid_token" } };
      }
      return { status: 200, data: { ok: true } };
    });

    const provider = new OrangeProvider({
      mode: "direct",
      directHttpClient,
    });

    const result = await provider.requestPayment(
      "+22507000002",
      "1500",
      "req-3",
    );

    expect(tokenFetchCount).toBe(2); // Initial fetch + exactly one re-fetch after 401.
    expect(paymentAttempts).toBe(2); // Rejected attempt + one retry that succeeds.
    expect(result.success).toBe(true);
    // The stale token must no longer be the one left in the shared cache.
    expect(await fakeRedisClient.get("orange:direct:token:" + sha256Scope()))
      .not.toBe("token-1");
  });
});

// Mirrors the credential-scoping hash OrangeProvider computes internally, so
// the second test can assert on the exact cache key without hardcoding the
// provider's private hashing implementation detail beyond what's needed to
// locate the key for the final assertion.
function sha256Scope(): string {
  const { createHash } = require("crypto");
  return createHash("sha256")
    .update("orange-key:orange-secret")
    .digest("hex")
    .slice(0, 16);
}
