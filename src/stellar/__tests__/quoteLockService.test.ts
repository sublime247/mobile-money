/**
 * Tests for the SEP-38 firm quote execution lock (#2557).
 *
 * Redis is replaced by a tiny in-memory fake that honours `SET NX PX` and the
 * compare-and-delete release script, so the tests exercise real lock
 * semantics (including concurrent acquisition) without a Redis server.
 */

import request from "supertest";
import express, { Express } from "express";

const store = new Map<string, { value: string; expiresAt: number }>();

const fakeRedis = {
  isOpen: true,
  set: jest.fn(
    async (
      key: string,
      value: string,
      opts?: { condition?: string; expiration?: { type: string; value: number } },
    ) => {
      const now = Date.now();
      const existing = store.get(key);
      if (opts?.condition === "NX" && existing && existing.expiresAt > now) {
        return null;
      }
      const ttl = opts?.expiration?.value ?? Number.MAX_SAFE_INTEGER;
      store.set(key, { value, expiresAt: now + ttl });
      return "OK";
    },
  ),
  get: jest.fn(async (key: string) => {
    const entry = store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }),
  del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  eval: jest.fn(
    async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
      const [key] = opts.keys;
      const [token] = opts.arguments;
      const entry = store.get(key);
      if (entry && entry.expiresAt > Date.now() && entry.value === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  ),
  incrbyfloat: jest.fn(async () => "0"),
};

jest.mock("../../config/redis", () => ({ redisClient: fakeRedis }));

jest.mock("../../middleware/rateLimiter", () => ({
  sep38RateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../services/layeredCache", () => ({
  layeredCache: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  },
}));

import {
  _resetQuoteLocks,
  acquireQuoteLock,
  quoteLockKey,
  QuoteLockConflictError,
  releaseQuoteLock,
  withQuoteLock,
} from "../quoteLockService";
import sep38Router, { setQuoteSettlementHandler } from "../../routes/sep38";
import { createQuote } from "../../services/sep38/quoteService";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  store.clear();
  _resetQuoteLocks();
  fakeRedis.isOpen = true;
  jest.clearAllMocks();
});

describe("acquireQuoteLock / releaseQuoteLock", () => {
  it("acquires an exclusive lock keyed on the quote ID with a PX TTL", async () => {
    const lock = await acquireQuoteLock("q-1", 5_000);

    expect(lock).not.toBeNull();
    expect(lock!.backend).toBe("redis");
    expect(fakeRedis.set).toHaveBeenCalledWith(
      quoteLockKey("q-1"),
      lock!.token,
      { condition: "NX", expiration: { type: "PX", value: 5_000 } },
    );
  });

  it("refuses a second acquisition while the first is held", async () => {
    const first = await acquireQuoteLock("q-1");
    const second = await acquireQuoteLock("q-1");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("does not block locks on different quotes", async () => {
    expect(await acquireQuoteLock("q-1")).not.toBeNull();
    expect(await acquireQuoteLock("q-2")).not.toBeNull();
  });

  it("allows re-acquisition after release", async () => {
    const first = await acquireQuoteLock("q-1");
    expect(await releaseQuoteLock(first!)).toBe(true);
    expect(await acquireQuoteLock("q-1")).not.toBeNull();
  });

  it("never releases a lock now held by someone else", async () => {
    const stale = await acquireQuoteLock("q-1", 10);
    await new Promise((r) => setTimeout(r, 20)); // stale lock expires
    const current = await acquireQuoteLock("q-1");
    expect(current).not.toBeNull();

    expect(await releaseQuoteLock(stale!)).toBe(false);
    // The current holder's lock is still in place.
    expect(await acquireQuoteLock("q-1")).toBeNull();
  });

  it("grants exactly one of many simultaneous acquisitions", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => acquireQuoteLock("q-race")),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it("falls back to an in-process lock when Redis is disconnected", async () => {
    fakeRedis.isOpen = false;

    const first = await acquireQuoteLock("q-1");
    expect(first!.backend).toBe("memory");
    expect(await acquireQuoteLock("q-1")).toBeNull();
    expect(fakeRedis.set).not.toHaveBeenCalled();

    expect(await releaseQuoteLock(first!)).toBe(true);
    expect(await acquireQuoteLock("q-1")).not.toBeNull();
  });

  it("rejects an invalid TTL", async () => {
    await expect(acquireQuoteLock("q-1", 0)).rejects.toThrow(/Invalid quote lock TTL/);
  });
});

describe("withQuoteLock", () => {
  it("rejects a concurrent execution with a 409 QuoteLockConflictError", async () => {
    const gate = deferred();
    const settle = jest.fn(async () => {
      await gate.promise;
      return "settled";
    });

    const first = withQuoteLock("q-1", settle);
    const second = withQuoteLock("q-1", settle);

    await expect(second).rejects.toBeInstanceOf(QuoteLockConflictError);
    await expect(second).rejects.toMatchObject({ statusCode: 409 });

    gate.resolve();
    await expect(first).resolves.toBe("settled");
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("releases the lock immediately after the transaction completes", async () => {
    await withQuoteLock("q-1", async () => "done");
    expect(store.has(quoteLockKey("q-1"))).toBe(false);
  });

  it("releases the lock when the transaction throws", async () => {
    await expect(
      withQuoteLock("q-1", async () => {
        throw new Error("horizon timeout");
      }),
    ).rejects.toThrow("horizon timeout");

    expect(store.has(quoteLockKey("q-1"))).toBe(false);
    expect(await acquireQuoteLock("q-1")).not.toBeNull();
  });
});

describe("POST /sep38/quote/:id/execute", () => {
  function makeApp(): Express {
    const app = express();
    app.use(express.json());
    app.use("/sep38", sep38Router);
    return app;
  }

  async function bookQuote(ownerId = "::ffff:127.0.0.1") {
    return createQuote({
      ownerId,
      sellAsset: "iso4217:XOF",
      buyAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      price: "0.0016",
      sellAmount: "10000",
      buyAmount: "16",
      ttlSeconds: 60,
    });
  }

  afterEach(() => setQuoteSettlementHandler(null));

  it("settles once and answers 409 to concurrent requests for the same quote", async () => {
    const app = makeApp();
    const quote = await bookQuote();

    const gate = deferred();
    const settle = jest.fn(async () => {
      await gate.promise;
      return { reference: "stellar-tx-abc" };
    });
    setQuoteSettlementHandler(settle);

    const firstReq = request(app).post(`/sep38/quote/${quote.id}/execute`).send({});
    const firstDone = firstReq.then((r) => r);

    // Wait until the first request is inside the critical section.
    while (settle.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app).post(`/sep38/quote/${quote.id}/execute`).send({}),
      ),
    );
    for (const res of concurrent) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("QUOTE_EXECUTION_IN_PROGRESS");
    }

    gate.resolve();
    const first = await firstDone;
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("executed");
    expect(first.body.settlement).toEqual({ reference: "stellar-tx-abc" });
    expect(settle).toHaveBeenCalledTimes(1);

    // Lock is gone, but the quote is now terminal — replay is still a 409.
    expect(store.has(quoteLockKey(quote.id))).toBe(false);
    const replay = await request(app).post(`/sep38/quote/${quote.id}/execute`).send({});
    expect(replay.status).toBe(409);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when settlement fails so the quote can be retried", async () => {
    const app = makeApp();
    const quote = await bookQuote();

    setQuoteSettlementHandler(async () => {
      throw new Error("fiat debit failed");
    });
    const failed = await request(app).post(`/sep38/quote/${quote.id}/execute`).send({});
    expect(failed.status).toBe(500);
    expect(store.has(quoteLockKey(quote.id))).toBe(false);

    setQuoteSettlementHandler(async () => ({ reference: "retry-ok" }));
    const retried = await request(app).post(`/sep38/quote/${quote.id}/execute`).send({});
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe("executed");
  });

  it("returns 404 for an unknown quote and 403 for a non-owner", async () => {
    const app = makeApp();
    const missing = await request(app).post("/sep38/quote/does-not-exist/execute").send({});
    expect(missing.status).toBe(404);

    const quote = await bookQuote("someone-else");
    const forbidden = await request(app).post(`/sep38/quote/${quote.id}/execute`).send({});
    expect(forbidden.status).toBe(403);
  });
});
