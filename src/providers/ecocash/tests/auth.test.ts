import axios from "axios";
import {
  DEFAULT_ECOCASH_TOKEN_TTL_SECONDS,
  ECOCASH_BACKOFF_DELAYS_MS,
  EcoCashAuthOptions,
  EcoCashTokenLock,
  EcoCashTokenStore,
  EcoCashTokenManager,
  createEcoCashAuth,
  isTransientTokenError,
} from "../auth";

class FakeStore implements EcoCashTokenStore {
  data = new Map<string, string>();
  ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, value);
    this.ttls.set(key, ttlMs);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
    this.ttls.delete(key);
  }
}

class FakeLock implements EcoCashTokenLock {
  held = new Set<string>();
  acquisitions = 0;

  async tryAcquire(resource: string) {
    if (this.held.has(resource)) return null;
    this.held.add(resource);
    this.acquisitions += 1;
    return {
      release: async () => {
        this.held.delete(resource);
      },
    };
  }
}

function serverError(status = 503): Error {
  return Object.assign(new Error(`EcoCash token endpoint returned ${status}`), {
    response: { status },
  });
}

function tokenFetcher(delayMs = 0) {
  let n = 0;
  return jest.fn(async () => {
    n += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { accessToken: `tok-${n}`, expiresIn: 3600 };
  });
}

function makeManager(
  overrides: Partial<EcoCashAuthOptions> & {
    store: FakeStore;
    lock: FakeLock;
  },
): EcoCashTokenManager {
  return new EcoCashTokenManager({
    keyId: "ecocash-client-id",
    fetchToken: tokenFetcher(),
    lockWaitMs: 200,
    pollIntervalMs: 5,
    ...overrides,
  });
}

describe("isTransientTokenError", () => {
  it.each([
    [{ response: { status: 500 } }, true],
    [{ response: { status: 503 } }, true],
    [{ status: 502 }, true],
    [{ response: { status: 400 } }, false],
    [{ response: { status: 401 } }, false],
    [new Error("network timeout"), false],
    [null, false],
  ])("%j -> %s", (error, expected) => {
    expect(isTransientTokenError(error)).toBe(expected);
  });
});

describe("EcoCashTokenManager", () => {
  let store: FakeStore;
  let lock: FakeLock;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new FakeStore();
    lock = new FakeLock();
  });

  it("fetches once and serves the cached token afterwards", async () => {
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken });

    expect(await auth.getToken()).toBe("tok-1");
    expect(await auth.getToken()).toBe("tok-1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("stores the token and expiry in Redis with the provider TTL", async () => {
    const now = 1_000_000;
    const auth = makeManager({ store, lock, now: () => now });

    expect(await auth.getToken()).toBe("tok-1");

    expect(auth.cacheKey).toMatch(/^ecocash:token:[0-9a-f]{16}$/);
    expect(store.ttls.get(auth.cacheKey)).toBe(3_600_000);
    expect(JSON.parse(store.data.get(auth.cacheKey)!)).toEqual({
      accessToken: "tok-1",
      expiresAt: now + 3_600_000,
    });
  });

  it("refreshes proactively when less than 300 seconds remain", async () => {
    let now = 0;
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken, now: () => now });

    expect(await auth.getToken()).toBe("tok-1");

    now = 3_600_000 - 299_000;
    expect(await auth.getToken()).toBe("tok-2");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("keeps using a token whose remaining validity exceeds the refresh window", async () => {
    let now = 0;
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken, now: () => now });

    await auth.getToken();
    now = 3_600_000 - 301_000;

    expect(await auth.getToken()).toBe("tok-1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("backs off 1s, 2s, 4s and 8s on 5xx responses", async () => {
    const delays: number[] = [];
    const fetchToken = jest
      .fn()
      .mockRejectedValueOnce(serverError(500))
      .mockRejectedValueOnce(serverError(502))
      .mockRejectedValueOnce(serverError(503))
      .mockRejectedValueOnce(serverError(504))
      .mockResolvedValueOnce({ accessToken: "tok-1", expiresIn: 3600 });
    const auth = makeManager({
      store,
      lock,
      fetchToken,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(await auth.getToken()).toBe("tok-1");
    expect(delays).toEqual(ECOCASH_BACKOFF_DELAYS_MS);
    expect(fetchToken).toHaveBeenCalledTimes(5);
  });

  it("stops after five transient failures and rethrows the last error", async () => {
    const delays: number[] = [];
    const fetchToken = jest.fn().mockRejectedValue(serverError(503));
    const auth = makeManager({
      store,
      lock,
      fetchToken,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(auth.getToken()).rejects.toThrow("503");
    expect(fetchToken).toHaveBeenCalledTimes(5);
    expect(delays).toEqual(ECOCASH_BACKOFF_DELAYS_MS);
    expect(lock.held.size).toBe(0);
  });

  it("does not retry a 4xx token error", async () => {
    const fetchToken = jest.fn().mockRejectedValue(serverError(401));
    const auth = makeManager({ store, lock, fetchToken });

    await expect(auth.getToken()).rejects.toThrow("401");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent callers into one token request", async () => {
    const fetchToken = tokenFetcher(20);
    const auth = makeManager({ store, lock, fetchToken });

    const tokens = await Promise.all([
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
    ]);

    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(lock.acquisitions).toBe(1);
  });

  it("uses a shared lock so multiple managers fetch only once", async () => {
    const fetchToken = tokenFetcher(20);
    const first = makeManager({
      store,
      lock,
      fetchToken,
      keyId: "same-client",
    });
    const second = makeManager({
      store,
      lock,
      fetchToken,
      keyId: "same-client",
    });

    const [firstToken, secondToken] = await Promise.all([
      first.getToken(),
      second.getToken(),
    ]);

    expect(firstToken).toBe(secondToken);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(lock.acquisitions).toBe(1);
  });

  it("waits for a lock holder to publish its token", async () => {
    const auth = makeManager({ store, lock, fetchToken: tokenFetcher() });
    lock.held.add(auth.lockResource);

    setTimeout(() => {
      store.data.set(
        auth.cacheKey,
        JSON.stringify({
          accessToken: "leader-token",
          expiresAt: Date.now() + 3_600_000,
        }),
      );
      lock.held.delete(auth.lockResource);
    }, 20);

    expect(await auth.getToken()).toBe("leader-token");
    expect(store.data.has(auth.cacheKey)).toBe(true);
  });

  it("reuses a token already stored in Redis by another worker", async () => {
    const first = makeManager({ store, lock, fetchToken: tokenFetcher() });
    await first.getToken();

    const secondFetch = tokenFetcher();
    const second = makeManager({ store, lock, fetchToken: secondFetch });

    expect(await second.getToken()).toBe("tok-1");
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("keeps working when the shared store is unavailable", async () => {
    store.get = jest.fn().mockRejectedValue(new Error("redis down"));
    store.set = jest.fn().mockRejectedValue(new Error("redis down"));
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken });

    expect(await auth.getToken()).toBe("tok-1");
    expect(await auth.getToken()).toBe("tok-1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected token and fetches a replacement", async () => {
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken });
    const token = await auth.getToken();

    await auth.invalidate(token);

    expect(store.data.has(auth.cacheKey)).toBe(false);
    expect(await auth.getToken()).toBe("tok-2");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("does not evict a newer shared token when invalidating a stale one", async () => {
    const auth = makeManager({ store, lock, fetchToken: tokenFetcher() });
    await auth.getToken();
    store.data.set(
      auth.cacheKey,
      JSON.stringify({
        accessToken: "newer-token",
        expiresAt: Date.now() + 3_600_000,
      }),
    );

    await auth.invalidate("old-token");

    expect(JSON.parse(store.data.get(auth.cacheKey)!).accessToken).toBe(
      "newer-token",
    );
  });

  it("falls back to the default TTL for a malformed expires_in", async () => {
    const now = 5_000;
    const auth = makeManager({
      store,
      lock,
      now: () => now,
      fetchToken: jest
        .fn()
        .mockResolvedValue({ accessToken: "tok-1", expiresIn: "soon" }),
    });

    await auth.getToken();

    expect(store.ttls.get(auth.cacheKey)).toBe(
      DEFAULT_ECOCASH_TOKEN_TTL_SECONDS * 1_000,
    );
    expect(JSON.parse(store.data.get(auth.cacheKey)!).expiresAt).toBe(
      now + DEFAULT_ECOCASH_TOKEN_TTL_SECONDS * 1_000,
    );
  });

  it("returns a Bearer authorization header", async () => {
    const auth = makeManager({ store, lock, fetchToken: tokenFetcher() });

    expect(await auth.getAuthorizationHeader()).toEqual({
      Authorization: "Bearer tok-1",
    });
  });

  it("rejects a token response without an access token", async () => {
    const auth = makeManager({
      store,
      lock,
      fetchToken: jest.fn().mockResolvedValue({ expiresIn: 3600 }),
    });

    await expect(auth.getToken()).rejects.toThrow(/access token/);
  });
});

describe("createEcoCashAuth", () => {
  let store: FakeStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new FakeStore();
  });

  it("exchanges client credentials for a token", async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: { access_token: "oauth-token", expires_in: 1800 },
    });
    const auth = createEcoCashAuth(
      {
        tokenUrl: "https://ecocash.example/token",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      { store, lock: new FakeLock(), now: () => 0 },
    );

    expect(await auth.getToken()).toBe("oauth-token");
    expect(axios.post).toHaveBeenCalledWith(
      "https://ecocash.example/token",
      new URLSearchParams({ grant_type: "client_credentials" }),
      expect.objectContaining({
        auth: { username: "client-id", password: "client-secret" },
      }),
    );
  });

  it("fails clearly when the token endpoint is not configured", async () => {
    const auth = createEcoCashAuth(
      { tokenUrl: "" },
      { store, lock: new FakeLock() },
    );

    await expect(auth.getToken()).rejects.toThrow(/not configured/);
  });
});
