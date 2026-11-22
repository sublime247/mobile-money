import {
  DEFAULT_MOMO_TOKEN_TTL_SECONDS,
  MomoAuthManager,
  MomoAuthOptions,
  MomoTokenLock,
  MomoTokenStore,
  isUnauthorizedError,
} from "../momoAuth";

/** In-memory stand-in for Redis (GET / SET PX / DEL) shared by "replicas". */
class FakeStore implements MomoTokenStore {
  data = new Map<string, string>();
  failing = false;
  async get(key: string) {
    if (this.failing) throw new Error("redis down");
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (this.failing) throw new Error("redis down");
    this.data.set(key, value);
  }
  async del(key: string) {
    if (this.failing) throw new Error("redis down");
    this.data.delete(key);
  }
}

/** In-memory stand-in for Redlock: one holder per resource, no retry. */
class FakeLock implements MomoTokenLock {
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

const unauthorized = () =>
  Object.assign(new Error("Request failed with status code 401"), {
    response: { status: 401 },
  });

function tokenFetcher(delayMs = 0) {
  let n = 0;
  const fetchToken = jest.fn(async () => {
    n += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { accessToken: `tok-${n}`, expiresIn: 3600 };
  });
  return fetchToken;
}

function makeManager(
  overrides: Partial<MomoAuthOptions> & {
    store: FakeStore;
    lock: FakeLock;
  },
) {
  return new MomoAuthManager({
    product: "collection",
    apiKey: "api-user",
    targetEnvironment: "sandbox",
    fetchToken: tokenFetcher(),
    lockWaitMs: 200,
    pollIntervalMs: 5,
    ...overrides,
  });
}

describe("MomoAuthManager", () => {
  let store: FakeStore;
  let lock: FakeLock;

  beforeEach(() => {
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

  it("stores the token in the shared cache with its expiry", async () => {
    const now = 1_000_000;
    const auth = makeManager({ store, lock, now: () => now });

    await auth.getToken();

    expect(JSON.parse(store.data.get(auth.cacheKey)!)).toEqual({
      accessToken: "tok-1",
      expiresAt: now + 3600 * 1000,
    });
  });

  it("does not leak the API key into the cache key", () => {
    const auth = makeManager({ store, lock });
    expect(auth.cacheKey).toMatch(/^mtn:momo:token:collection:sandbox:/);
    expect(auth.cacheKey).not.toContain("api-user");
  });

  it("collapses concurrent callers in one process into a single fetch", async () => {
    const fetchToken = tokenFetcher(20);
    const auth = makeManager({ store, lock, fetchToken });

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => auth.getToken()),
    );

    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("lets only one replica hit the token endpoint during a stampede", async () => {
    const fetchToken = tokenFetcher(30);
    const replicas = Array.from({ length: 5 }, () =>
      makeManager({ store, lock, fetchToken }),
    );

    const tokens = await Promise.all(replicas.map((r) => r.getToken()));

    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(lock.acquisitions).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
  });

  it("reuses a token another replica already stored", async () => {
    const first = makeManager({ store, lock, fetchToken: tokenFetcher() });
    await first.getToken();

    const secondFetch = tokenFetcher();
    const second = makeManager({ store, lock, fetchToken: secondFetch });

    expect(await second.getToken()).toBe("tok-1");
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("refreshes in the background once inside the refresh window", async () => {
    let now = 0;
    const fetchToken = tokenFetcher();
    const auth = makeManager({
      store,
      lock,
      fetchToken,
      refreshWindowMs: 60_000,
      now: () => now,
    });

    expect(await auth.getToken()).toBe("tok-1");

    // 30 s before expiry: still valid, but inside the 60 s window.
    now = 3600 * 1000 - 30_000;
    expect(await auth.getToken()).toBe("tok-1");
    await new Promise((r) => setImmediate(r));

    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(await auth.getToken()).toBe("tok-2");
  });

  it("blocks for a new token once the current one has expired", async () => {
    let now = 0;
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken, now: () => now });

    await auth.getToken();
    now = 3600 * 1000 + 1;

    expect(await auth.getToken()).toBe("tok-2");
  });

  it("waits for the lock holder's token instead of fetching", async () => {
    const auth = makeManager({ store, lock, fetchToken: tokenFetcher() });
    lock.held.add(auth.lockResource); // another replica is refreshing

    setTimeout(() => {
      store.data.set(
        auth.cacheKey,
        JSON.stringify({
          accessToken: "leader",
          expiresAt: Date.now() + 3.6e6,
        }),
      );
      lock.held.delete(auth.lockResource);
    }, 30);

    expect(await auth.getToken()).toBe("leader");
  });

  it("fetches directly if the lock holder never publishes a token", async () => {
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken, lockWaitMs: 30 });
    lock.held.add(auth.lockResource); // holder crashed while holding the lock

    expect(await auth.getToken()).toBe("tok-1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("keeps working when the shared cache is down", async () => {
    store.failing = true;
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken });

    expect(await auth.getToken()).toBe("tok-1");
    expect(await auth.getToken()).toBe("tok-1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("releases the lock even when the token request fails", async () => {
    const auth = makeManager({
      store,
      lock,
      fetchToken: jest.fn().mockRejectedValue(new Error("MTN down")),
    });

    await expect(auth.getToken()).rejects.toThrow("MTN down");
    expect(lock.held.size).toBe(0);
  });

  it("rejects a token response without access_token", async () => {
    const auth = makeManager({
      store,
      lock,
      fetchToken: jest.fn().mockResolvedValue({ expiresIn: 3600 }),
    });

    await expect(auth.getToken()).rejects.toThrow(/access_token/);
  });

  it("falls back to the default lifetime for a malformed expires_in", async () => {
    const now = 5_000;
    const auth = makeManager({
      store,
      lock,
      now: () => now,
      fetchToken: jest
        .fn()
        .mockResolvedValue({ accessToken: "t", expiresIn: "soon" }),
    });

    await auth.getToken();

    expect(JSON.parse(store.data.get(auth.cacheKey)!).expiresAt).toBe(
      now + DEFAULT_MOMO_TOKEN_TTL_SECONDS * 1000,
    );
  });

  describe("401 handling", () => {
    it("invalidates the token everywhere and retries once", async () => {
      const fetchToken = tokenFetcher();
      const auth = makeManager({ store, lock, fetchToken });
      const call = jest
        .fn()
        .mockRejectedValueOnce(unauthorized())
        .mockResolvedValueOnce("ok");

      await expect(auth.withAuthRetry(call)).resolves.toBe("ok");

      expect(call).toHaveBeenNthCalledWith(1, "tok-1");
      expect(call).toHaveBeenNthCalledWith(2, "tok-2");
      expect(JSON.parse(store.data.get(auth.cacheKey)!).accessToken).toBe(
        "tok-2",
      );
    });

    it("gives up after a second 401", async () => {
      const auth = makeManager({ store, lock });
      const call = jest.fn().mockRejectedValue(unauthorized());

      await expect(auth.withAuthRetry(call)).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(call).toHaveBeenCalledTimes(2);
    });

    it("does not retry other errors", async () => {
      const fetchToken = tokenFetcher();
      const auth = makeManager({ store, lock, fetchToken });
      const call = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("boom"), { response: { status: 500 } }),
        );

      await expect(auth.withAuthRetry(call)).rejects.toThrow("boom");
      expect(call).toHaveBeenCalledTimes(1);
      expect(fetchToken).toHaveBeenCalledTimes(1);
    });

    it("does not evict a newer token another replica already stored", async () => {
      const auth = makeManager({ store, lock });
      await auth.getToken(); // tok-1 stored
      store.data.set(
        auth.cacheKey,
        JSON.stringify({ accessToken: "newer", expiresAt: Date.now() + 3.6e6 }),
      );

      await auth.invalidate("tok-1");

      expect(JSON.parse(store.data.get(auth.cacheKey)!).accessToken).toBe(
        "newer",
      );
      expect(await auth.getToken()).toBe("newer");
    });

    it("uses the supplied token source for both attempts", async () => {
      const auth = makeManager({ store, lock });
      const getToken = jest
        .fn()
        .mockResolvedValueOnce("first")
        .mockResolvedValueOnce("second");
      const call = jest
        .fn()
        .mockRejectedValueOnce(unauthorized())
        .mockResolvedValueOnce("ok");

      await auth.withAuthRetry(call, getToken);

      expect(call.mock.calls).toEqual([["first"], ["second"]]);
    });
  });
});

describe("isUnauthorizedError", () => {
  it.each([
    [{ response: { status: 401 } }, true],
    [{ status: 401 }, true],
    [{ statusCode: 401 }, true],
    [{ response: { status: 403 } }, false],
    [new Error("x"), false],
    [null, false],
  ])("%j -> %s", (error, expected) => {
    expect(isUnauthorizedError(error)).toBe(expected);
  });
});
