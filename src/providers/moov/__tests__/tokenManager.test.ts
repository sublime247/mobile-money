import { createHash } from "crypto";
import {
  DEFAULT_MOOV_TOKEN_TTL_SECONDS,
  MoovAuthOptions,
  MoovTokenLock,
  MoovTokenManager,
  MoovTokenStore,
  isInvalidGrantError,
} from "../tokenManager";

function cacheKeyFor(clientId: string): string {
  return `moov:token:${createHash("sha256").update(clientId).digest("hex").slice(0, 16)}`;
}

/** In-memory stand-in for Redis (GET / SET PX / DEL) shared by "replicas". */
class FakeStore implements MoovTokenStore {
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
class FakeLock implements MoovTokenLock {
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

const invalidGrant = () =>
  Object.assign(new Error("invalid_grant"), {
    response: { status: 400, data: { error: "invalid_grant" } },
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
  overrides: Partial<MoovAuthOptions> & {
    store: FakeStore;
    lock: FakeLock;
  },
) {
  return new MoovTokenManager({
    clientId: "moov-client-id",
    clientSecret: "moov-client-secret",
    fetchToken: tokenFetcher(),
    lockWaitMs: 200,
    pollIntervalMs: 5,
    ...overrides,
  });
}

describe("MoovTokenManager", () => {
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

  it("stores the token (and expiry) in the shared cache with a 3600s TTL", async () => {
    const now = 1_000_000;
    const auth = makeManager({ store, lock, now: () => now });

    await auth.getToken();

    const stored = JSON.parse(store.data.get(auth.cacheKey)!);
    expect(stored.accessToken).toBe("tok-1");
    expect(stored.expiresAt).toBe(now + 3600 * 1000);
  });

  it("does not leak the client id or secret into the cache key", () => {
    const auth = makeManager({ store, lock });
    expect(auth.cacheKey).toMatch(/^moov:token:[0-9a-f]{16}$/);
    expect(auth.cacheKey).not.toContain("moov-client-id");
    expect(auth.cacheKey).not.toContain("moov-client-secret");
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

  it("uses the Redlock mutex so only one of several concurrent workers refreshes (#2366)", async () => {
    const fetchToken = tokenFetcher(30);
    const workers = Array.from({ length: 5 }, () =>
      makeManager({ store, lock, fetchToken }),
    );

    const tokens = await Promise.all(workers.map((w) => w.getToken()));

    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(lock.acquisitions).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
  });

  it("reuses a token another worker already stored in Redis", async () => {
    const first = makeManager({ store, lock, fetchToken: tokenFetcher() });
    await first.getToken();

    const secondFetch = tokenFetcher();
    const second = makeManager({ store, lock, fetchToken: secondFetch });

    expect(await second.getToken()).toBe("tok-1");
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("refreshes in the background 5 minutes before expiry by default", async () => {
    let now = 0;
    const fetchToken = tokenFetcher();
    const auth = makeManager({ store, lock, fetchToken, now: () => now });

    expect(await auth.getToken()).toBe("tok-1");

    // 4 minutes before expiry: still valid, but inside the default 5-minute
    // renewal buffer.
    now = 3600 * 1000 - 4 * 60_000;
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

  it("waits for the lock holder's token instead of fetching its own", async () => {
    const auth = makeManager({ store, lock, fetchToken: tokenFetcher() });
    lock.held.add(auth.lockResource); // another worker is refreshing

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
      fetchToken: jest.fn().mockRejectedValue(new Error("Moov down")),
    });

    await expect(auth.getToken()).rejects.toThrow("Moov down");
    expect(lock.held.size).toBe(0);
  });

  it("rejects a token response without an access token", async () => {
    const auth = makeManager({
      store,
      lock,
      fetchToken: jest.fn().mockResolvedValue({ expiresIn: 3600 }),
    });

    await expect(auth.getToken()).rejects.toThrow(/access token/);
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
      now + DEFAULT_MOOV_TOKEN_TTL_SECONDS * 1000,
    );
  });

  describe("refresh token rotation (#2366)", () => {
    it("uses the refresh-token grant instead of client credentials when a refresh token is cached", async () => {
      const fetchToken = tokenFetcher();
      const refreshWithToken = jest
        .fn()
        .mockResolvedValue({ accessToken: "rotated-1", expiresIn: 3600 });

      // Seed the shared cache with an expired token that carries a refresh
      // token, as a prior fetchAndStore() would have stored it.
      store.data.set(
        cacheKeyFor("moov-client-id"),
        JSON.stringify({
          accessToken: "expired",
          expiresAt: 0,
          refreshToken: "refresh-abc",
        }),
      );

      const auth = makeManager({
        store,
        lock,
        fetchToken,
        refreshWithToken,
        now: () => 1,
      });

      expect(await auth.getToken()).toBe("rotated-1");
      expect(refreshWithToken).toHaveBeenCalledWith("refresh-abc");
      expect(fetchToken).not.toHaveBeenCalled();
    });

    it("falls back to a client-credentials grant when the refresh token is rejected as invalid_grant", async () => {
      const fetchToken = tokenFetcher();
      const refreshWithToken = jest.fn().mockRejectedValue(invalidGrant());

      store.data.set(
        cacheKeyFor("moov-client-id"),
        JSON.stringify({
          accessToken: "expired",
          expiresAt: 0,
          refreshToken: "revoked-refresh-token",
        }),
      );

      const auth = makeManager({
        store,
        lock,
        fetchToken,
        refreshWithToken,
        now: () => 1,
      });

      expect(await auth.getToken()).toBe("tok-1");
      expect(refreshWithToken).toHaveBeenCalledWith("revoked-refresh-token");
      expect(fetchToken).toHaveBeenCalledTimes(1);
    });

    it("re-throws a refresh-token error that is not an invalid_grant", async () => {
      const fetchToken = tokenFetcher();
      const refreshWithToken = jest
        .fn()
        .mockRejectedValue(new Error("network timeout"));

      store.data.set(
        cacheKeyFor("moov-client-id"),
        JSON.stringify({
          accessToken: "expired",
          expiresAt: 0,
          refreshToken: "refresh-abc",
        }),
      );

      const auth = makeManager({
        store,
        lock,
        fetchToken,
        refreshWithToken,
        now: () => 1,
      });

      await expect(auth.getToken()).rejects.toThrow("network timeout");
      expect(fetchToken).not.toHaveBeenCalled();
    });

    it("stores the new refresh token returned by a grant for the next rotation", async () => {
      const fetchToken = jest.fn().mockResolvedValue({
        accessToken: "tok-1",
        expiresIn: 3600,
        refreshToken: "refresh-xyz",
      });
      const auth = makeManager({ store, lock, fetchToken, now: () => 0 });

      await auth.getToken();

      const stored = JSON.parse(store.data.get(auth.cacheKey)!);
      expect(stored.refreshToken).toBe("refresh-xyz");
    });

    it("uses client credentials when no refresh token is cached, even if refreshWithToken is supplied", async () => {
      const fetchToken = tokenFetcher();
      const refreshWithToken = jest.fn();
      const auth = makeManager({ store, lock, fetchToken, refreshWithToken });

      expect(await auth.getToken()).toBe("tok-1");
      expect(refreshWithToken).not.toHaveBeenCalled();
      expect(fetchToken).toHaveBeenCalledTimes(1);
    });
  });
});

describe("isInvalidGrantError", () => {
  it.each([
    [{ response: { status: 400, data: { error: "invalid_grant" } } }, true],
    [{ code: "invalid_grant" }, true],
    [new Error("invalid_grant: refresh token expired"), true],
    [{ response: { status: 400 } }, true],
    [{ response: { status: 401 } }, true],
    [{ response: { status: 500 } }, false],
    [{ status: 500 }, false],
    [null, false],
  ])("%j -> %s", (error, expected) => {
    expect(isInvalidGrantError(error)).toBe(expected);
  });
});
