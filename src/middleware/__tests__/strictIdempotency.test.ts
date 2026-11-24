/**
 * Tests for the strict Redis-backed idempotency middleware (issues #1972 and
 * #2161).
 *
 * Verifies locally using a mock execution framework (in-memory Redis mock
 * and mock handlers) per the issue's verification guidance.
 */

process.env.NODE_ENV = "test";

import crypto from "crypto";
import type { Request, Response } from "express";

const store = new Map<string, string>();
const locks = new Set<string>();

jest.mock("../../config/redis", () => ({
  redisClient: {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    isOpen: true,
  },
}));

jest.mock("../../utils/lock", () => {
  class MockLockError extends Error {
    readonly isContention: boolean;
    constructor(isContention: boolean) {
      super("lock acquisition failed");
      this.isContention = isContention;
    }
  }
  return {
    lockManager: {
      acquire: jest.fn(async (resource: string) => {
        if (locks.has(resource)) throw new MockLockError(true);
        locks.add(resource);
        return { resource };
      }),
      release: jest.fn(async (lock: { resource: string }) => {
        locks.delete(lock.resource);
      }),
    },
    isLockAcquisitionError: (e: unknown) => e instanceof MockLockError,
    LockKeys: { idempotency: (key: string) => `idempotency:${key}` },
  };
});

import { optionalIdempotency, strictIdempotency } from "../idempotency";

type Res = Response & { statusCode: number; body: unknown };

function makeRes(): Res {
  const res: any = {};
  (res.statusCode = 200), (res.body = undefined);
  res.headersSent = false;
  res.setHeader = jest.fn();
  res.on = jest.fn();
  res.status = jest.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn((b: unknown) => {
    res.body = b;
    res.headersSent = true;
    return res;
  });
  res.send = jest.fn((b: unknown) => {
    res.body = b;
    res.headersSent = true;
    return res;
  });
  return res as Res;
}

function makeReq(
  overrides: Partial<Request> & { idempotencyKey?: string; body?: unknown } = {},
): Request {
  return {
    method: "POST",
    baseUrl: "",
    path: "/deposit",
    originalUrl: "/api/transactions/deposit",
    headers: overrides.idempotencyKey
      ? { "idempotency-key": overrides.idempotencyKey }
      : {},
    body: overrides.body ?? { amount: 100 },
    query: {},
    jwtUser: { userId: "user-1" },
  } as unknown as Request;
}

function run(
  req: Request,
  res: Res,
  handler: () => Promise<void> | void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    // Resolve when the middleware itself responds (no handler call).
    const poll = setInterval(() => {
      if ((res as any).headersSent) {
        clearInterval(poll);
        settle();
      }
    }, 5);
    // The middleware is async: a synchronous throw from the handler
    // propagates through its returned promise (mirrors how the async-error
    // patched Express layer surfaces handler failures).
    const mwPromise = (
      strictIdempotency as unknown as (
        r: Request,
        s: Res,
        n: (err?: unknown) => void,
      ) => Promise<void>
    )(req, res, (err?: unknown) => {
      clearInterval(poll);
      void Promise.resolve(handler())
        .then(settle)
        .catch(reject);
    });
    mwPromise.catch((err: unknown) => {
      clearInterval(poll);
      reject(err);
    });
  });
}

beforeEach(async () => {
  store.clear();
  locks.clear();
  jest.clearAllMocks();
  // Let any pending microtasks (Redis writes) from prior tests settle.
  await new Promise((r) => setImmediate(r));
});

/** Resource name the middleware locks for a given cache key. */
function lockResourceFor(cacheKey: string): string {
  return `idempotency:${crypto.createHash("sha256").update(cacheKey).digest("hex")}`;
}

describe("strictIdempotency (#1972)", () => {
  it("rejects requests missing the Idempotency-Key header with 400", async () => {
    const req = makeReq();
    const res = makeRes();
    let executed = false;

    await run(req, res, () => {
      executed = true;
    });

    expect(res.statusCode).toBe(400);
    expect(executed).toBe(false);
  });

  it("executes the handler and caches the response with a 24h TTL", async () => {
    const req = makeReq({ idempotencyKey: "key-1" });
    const res = makeRes();

    await run(req, res, () => {
      res.status(201).json({ id: "txn-1", status: "pending" });
    });

    expect(res.statusCode).toBe(201);
    // Allow the async cache write to settle.
    await new Promise((r) => setImmediate(r));
    const cached = store.get("idempotency:user-1:POST:/deposit:key-1");
    expect(cached).toBeDefined();
    const parsed = JSON.parse(cached!);
    expect(parsed.status).toBe(201);
    expect(parsed.body).toEqual({ id: "txn-1", status: "pending" });

    // TTL flag was passed to redis set (24h = 86400s).
    const setCalls = (require("../../config/redis").redisClient.set as jest.Mock)
      .mock.calls.filter((c: unknown[]) => c[0] === "idempotency:user-1:POST:/deposit:key-1");
    expect(setCalls.length).toBeGreaterThan(0);
    expect(setCalls[0][2]).toMatchObject({ EX: 24 * 60 * 60 });
  });

  it("replays the identical cached response without re-executing", async () => {
    const req = makeReq({ idempotencyKey: "key-2" });
    const res1 = makeRes();
    await run(req, res1, () => {
      res1.status(200).json({ id: "txn-2" });
    });

    let executions = 0;
    const res2 = makeRes();
    await run(req, res2, () => {
      executions += 1;
      res2.status(200).json({ id: "different" });
    });

    expect(executions).toBe(0);
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toEqual({ id: "txn-2" });
  });

  it("rejects a different payload reusing the same key with 422", async () => {
    const res1 = makeRes();
    await run(
      makeReq({ idempotencyKey: "key-3", body: { amount: 100 } }),
      res1,
      () => {
        res1.status(200).json({ ok: true });
      },
    );

    const res2 = makeRes();
    await run(
      makeReq({ idempotencyKey: "key-3", body: { amount: 999 } }),
      res2,
      () => {
        res2.status(200).json({ ok: true });
      },
    );

    expect(res2.statusCode).toBe(422);
    expect((res2.body as { error: string }).error).toBe(
      "idempotency_key_reuse",
    );
  });

  it("returns 409 for a concurrent duplicate while the first is executing", async () => {
    // simulate in-flight request holding the lock
    locks.add(lockResourceFor("idempotency:user-1:POST:/deposit:key-4"));

    const res = makeRes();
    let executed = false;
    await run(makeReq({ idempotencyKey: "key-4" }), res, () => {
      executed = true;
    });

    expect(res.statusCode).toBe(409);
    expect(executed).toBe(false);
  });

  it("scopes cache keys by user so identities cannot collide", async () => {
    const res1 = makeRes();
    await run(makeReq({ idempotencyKey: "shared" }), res1, () => {
      res1.status(200).json({ owner: "user-1" });
    });

    const req2 = makeReq({ idempotencyKey: "shared" });
    (req2 as any).jwtUser = { userId: "user-2" };
    const res2 = makeRes();
    let executed2 = false;
    await run(req2, res2, () => {
      executed2 = true;
      res2.status(200).json({ owner: "user-2" });
    });

    expect(executed2).toBe(true);
    expect(res2.body).toEqual({ owner: "user-2" });
  });

  it("releases the in-flight lock when the handler errors without responding", async () => {
    const req = makeReq({ idempotencyKey: "key-5" });
    const res = makeRes();

    // Simulate Express: handler throws, error middleware short-circuits the
    // response without ever calling res.json/res.send. The finish listener
    // then releases the in-flight lock.
    await expect(
      run(req, res, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Emit the response-cycle end events the middleware listens for.
    const finishCbs = ((res as any).on as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === "finish",
    );
    expect(finishCbs.length).toBeGreaterThan(0);
    for (const [, cb] of finishCbs) (cb as () => void)();

    await new Promise((r) => setImmediate(r));
    expect(locks.size).toBe(0);

    // A retry after the failure executes normally.
    const res2 = makeRes();
    let executed = false;
    await run(req, res2, () => {
      executed = true;
      res2.status(200).json({ ok: true });
    });
    expect(executed).toBe(true);
  });
});

describe("strictIdempotency distributed locking (#2161)", () => {
  it("lets only one of many parallel duplicates execute; the rest get 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;

    const responses = Array.from({ length: 5 }, () => makeRes());
    const runs = responses.map((res) =>
      run(makeReq({ idempotencyKey: "parallel-1" }), res, async () => {
        executions += 1;
        await gate;
        res.status(201).json({ id: "txn-parallel" });
      }),
    );

    // Duplicates are rejected immediately while the first is still running.
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all(runs);

    expect(executions).toBe(1);
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  it("serves a retry after completion from the cache and frees the lock", async () => {
    const res1 = makeRes();
    await run(makeReq({ idempotencyKey: "parallel-2" }), res1, () => {
      res1.status(201).json({ id: "txn-2" });
    });
    await new Promise((r) => setImmediate(r));
    expect(locks.size).toBe(0);

    let executions = 0;
    const res2 = makeRes();
    await run(makeReq({ idempotencyKey: "parallel-2" }), res2, () => {
      executions += 1;
    });

    expect(executions).toBe(0);
    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual({ id: "txn-2" });
  });

  it("replays instead of re-executing when the first request finishes before the lock is taken", async () => {
    const res1 = makeRes();
    await run(makeReq({ idempotencyKey: "race-1" }), res1, () => {
      res1.status(201).json({ id: "txn-race" });
    });
    await new Promise((r) => setImmediate(r));

    // The duplicate's first cache lookup misses (it ran before the first
    // request cached its response); only the post-lock re-check sees it.
    (
      require("../../config/redis").redisClient.get as jest.Mock
    ).mockImplementationOnce(async () => null);

    let executions = 0;
    const res2 = makeRes();
    await run(makeReq({ idempotencyKey: "race-1" }), res2, () => {
      executions += 1;
    });

    expect(executions).toBe(0);
    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual({ id: "txn-race" });
    expect(locks.size).toBe(0);
  });

  it("fails open without a 409 when the lock backend is unavailable", async () => {
    (
      require("../../utils/lock").lockManager.acquire as jest.Mock
    ).mockRejectedValueOnce(new Error("redis down"));

    let executed = false;
    const res = makeRes();
    await run(makeReq({ idempotencyKey: "outage-1" }), res, () => {
      executed = true;
      res.status(200).json({ ok: true });
    });

    expect(executed).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});

describe("optionalIdempotency (#2161)", () => {
  it("passes through without touching Redis when no key is supplied", async () => {
    const next = jest.fn();
    await optionalIdempotency(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(
      require("../../config/redis").redisClient.get as jest.Mock,
    ).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  });

  it("passes through when the key header is blank", async () => {
    const req = makeReq();
    (req as any).headers = { "idempotency-key": "   " };
    const next = jest.fn();
    await optionalIdempotency(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("applies full idempotency when a key is supplied", async () => {
    const res1 = makeRes();
    await new Promise<void>((resolve) => {
      const out = optionalIdempotency(
        makeReq({ idempotencyKey: "hook-1" }),
        res1,
        () => {
          res1.status(200).json({ received: true });
          resolve();
        },
      );
      void out;
    });
    await new Promise((r) => setImmediate(r));

    let executions = 0;
    const res2 = makeRes();
    await optionalIdempotency(
      makeReq({ idempotencyKey: "hook-1" }),
      res2,
      () => {
        executions += 1;
      },
    );

    expect(executions).toBe(0);
    expect(res2.body).toEqual({ received: true });
  });
});
