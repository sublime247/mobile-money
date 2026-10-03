process.env.NODE_ENV = "test";

import type { Request, Response } from "express";

const store = new Map<string, string>();
const locks = new Set<string>();

const mockRedisClient = {
  get: jest.fn(async (key: string) => store.get(key) ?? null),
  set: jest.fn(
    async (
      key: string,
      value: string,
      opts?: { NX?: boolean; EX?: number },
    ) => {
      if (opts?.NX) {
        if (locks.has(key)) return null;
        locks.add(key);
        store.set(key, value);
        return "OK";
      }
      store.set(key, value);
      return "OK";
    },
  ),
  del: jest.fn(async (key: string) => {
    store.delete(key);
    locks.delete(key);
    return 1;
  }),
  isOpen: true,
  eval: jest.fn(),
};

jest.mock("../../config/redis", () => ({
  redisClient: mockRedisClient,
}));

const mockRedlockRelease = jest.fn(async (lock: any) => {
  if (lock && lock.resource) {
    locks.delete(`${lock.resource}:lock`);
  }
});

const mockLockManager = {
  tryAcquire: jest.fn(async (resource: string, _ttl: number) => {
    const lockKey = `${resource}:lock`;
    if (locks.has(lockKey)) return null;
    locks.add(lockKey);
    return { resource, resources: [resource], value: "redlock-val" };
  }),
  release: mockRedlockRelease,
};

jest.mock("../../utils/lock", () => ({
  lockManager: mockLockManager,
  LockKeys: {
    idempotency: (key: string) => `idempotency:${key}`,
  },
}));

import {
  idempotency,
  strictIdempotency,
  createIdempotencyMiddleware,
  buildCacheKey,
  fingerprintRequest,
  getIoRedisClient,
  setIoRedisClient,
  IDEMPOTENCY_TTL_SECONDS,
} from "../idempotency";

type MockRes = Response & {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  _headers: Record<string, string>;
  _events: Record<string, Array<() => void>>;
};

function makeRes(): MockRes {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    _headers: {},
    _events: {},
  };

  res.setHeader = jest.fn((k: string, v: string) => {
    res._headers[k.toLowerCase()] = v;
  });
  res.getHeader = jest.fn((k: string) => res._headers[k.toLowerCase()]);
  res.on = jest.fn((event: string, cb: () => void) => {
    if (!res._events[event]) res._events[event] = [];
    res._events[event].push(cb);
    return res;
  });
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

  return res as MockRes;
}

function makeReq(
  overrides: Partial<Request> & {
    idempotencyKey?: string;
    body?: unknown;
    path?: string;
    method?: string;
    userId?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (overrides.idempotencyKey) {
    headers["idempotency-key"] = overrides.idempotencyKey;
  }

  return {
    method: overrides.method || "POST",
    baseUrl: "",
    path: overrides.path || "/api/transactions/process",
    originalUrl: overrides.path || "/api/transactions/process",
    headers,
    body: overrides.body ?? { amount: 500, recipient: "+254712345678" },
    query: {},
    jwtUser: overrides.userId ? { userId: overrides.userId } : { userId: "user-100" },
  } as unknown as Request;
}

function runMiddleware(
  mw: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>,
  req: Request,
  res: MockRes,
  handler?: () => Promise<void> | void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let completed = false;
    const finish = () => {
      if (!completed) {
        completed = true;
        resolve();
      }
    };

    const poll = setInterval(() => {
      if (res.headersSent) {
        clearInterval(poll);
        finish();
      }
    }, 5);

    mw(req, res, (err?: unknown) => {
      clearInterval(poll);
      if (err) return reject(err);
      if (handler) {
        void Promise.resolve(handler())
          .then(finish)
          .catch(reject);
      } else {
        finish();
      }
    }).catch((err: unknown) => {
      clearInterval(poll);
      reject(err);
    });
  });
}

describe("Redis Distributed Lock Idempotency Middleware Suite (#2161)", () => {
  beforeEach(async () => {
    store.clear();
    locks.clear();
    jest.clearAllMocks();
    mockLockManager.tryAcquire.mockImplementation(async (resource: string) => {
      const lockKey = `${resource}:lock`;
      if (locks.has(lockKey)) return null;
      locks.add(lockKey);
      return { resource, resources: [resource], value: "redlock-val" };
    });
    mockLockManager.release.mockImplementation(async (lock: any) => {
      if (lock && lock.resource) {
        locks.delete(`${lock.resource}:lock`);
      }
    });
    await new Promise((r) => setImmediate(r));
  });

  describe("Utility & Key Generation", () => {
    it("should build scoped cache key incorporating method, path, user identity, and idempotency key", () => {
      const req = makeReq({ idempotencyKey: "test-key-1", userId: "agent-007" });
      const cacheKey = buildCacheKey(req, "test-key-1");
      expect(cacheKey).toBe("idempotency:agent-007:POST:/api/transactions/process:test-key-1");
    });

    it("should generate deterministic SHA-256 fingerprint for identical request payload", () => {
      const req1 = makeReq({ idempotencyKey: "fp-key", body: { amount: 100 } });
      const req2 = makeReq({ idempotencyKey: "fp-key", body: { amount: 100 } });
      const fp1 = fingerprintRequest(req1, "fp-key");
      const fp2 = fingerprintRequest(req2, "fp-key");
      expect(fp1).toBe(fp2);
    });

    it("should generate different fingerprints when payload fields differ", () => {
      const req1 = makeReq({ idempotencyKey: "fp-key", body: { amount: 100 } });
      const req2 = makeReq({ idempotencyKey: "fp-key", body: { amount: 200 } });
      const fp1 = fingerprintRequest(req1, "fp-key");
      const fp2 = fingerprintRequest(req2, "fp-key");
      expect(fp1).not.toBe(fp2);
    });
  });

  describe("Optional vs Strict Header Handling", () => {
    it("should allow request to proceed without locking when Idempotency-Key is not provided (standard idempotency)", async () => {
      const req = makeReq();
      const res = makeRes();
      let executed = false;

      await runMiddleware(idempotency, req, res, () => {
        executed = true;
        res.status(200).json({ ok: true });
      });

      expect(executed).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(mockRedisClient.set).not.toHaveBeenCalled();
    });

    it("should reject request with 400 when Idempotency-Key is required but missing (strictIdempotency)", async () => {
      const req = makeReq();
      const res = makeRes();
      let executed = false;

      await runMiddleware(strictIdempotency, req, res, () => {
        executed = true;
      });

      expect(executed).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_request" });
    });
  });

  describe("Single Request Execution & 60s TTL Caching", () => {
    it("should execute transaction handler and cache finalized response with 60s TTL", async () => {
      const req = makeReq({ idempotencyKey: "tx-60s-1" });
      const res = makeRes();

      await runMiddleware(idempotency, req, res, () => {
        res.status(200).json({ status: "success", txId: "tx-12345" });
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ status: "success", txId: "tx-12345" });

      await new Promise((r) => setImmediate(r));

      // Verify that response was cached in Redis with EX = 60 seconds
      const cacheKey = buildCacheKey(req, "tx-60s-1");
      const cached = store.get(cacheKey);
      expect(cached).toBeDefined();

      const parsed = JSON.parse(cached!);
      expect(parsed.status).toBe(200);
      expect(parsed.body).toEqual({ status: "success", txId: "tx-12345" });

      const setCalls = mockRedisClient.set.mock.calls.filter((c: unknown[]) => c[0] === cacheKey);
      expect(setCalls.length).toBeGreaterThan(0);
      expect(setCalls[0][2]).toMatchObject({ EX: IDEMPOTENCY_TTL_SECONDS });
      expect(IDEMPOTENCY_TTL_SECONDS).toBe(60);
    });

    it("should release distributed lock after response caching finishes", async () => {
      const req = makeReq({ idempotencyKey: "tx-lock-rel-1" });
      const res = makeRes();

      await runMiddleware(idempotency, req, res, () => {
        res.status(200).json({ ok: true });
      });

      await new Promise((r) => setImmediate(r));

      const cacheKey = buildCacheKey(req, "tx-lock-rel-1");
      const lockKey = `${cacheKey}:lock`;
      expect(locks.has(lockKey)).toBe(false);
    });
  });

  describe("Subsequent Replay & Payload Validation", () => {
    it("should replay identical cached response within TTL with Idempotency-Replayed header without re-executing handler", async () => {
      const req = makeReq({ idempotencyKey: "replay-key-1" });
      const res1 = makeRes();

      let executionCount = 0;
      await runMiddleware(idempotency, req, res1, () => {
        executionCount += 1;
        res1.status(200).json({ transaction_id: "orig-100", amount: 500 });
      });

      expect(executionCount).toBe(1);
      expect(res1.statusCode).toBe(200);

      // Second identical request
      const res2 = makeRes();
      await runMiddleware(idempotency, req, res2, () => {
        executionCount += 1;
        res2.status(200).json({ transaction_id: "duplicate-should-not-happen" });
      });

      expect(executionCount).toBe(1); // Handler was not re-executed
      expect(res2.statusCode).toBe(200);
      expect(res2.body).toEqual({ transaction_id: "orig-100", amount: 500 });
      expect(res2.getHeader("Idempotency-Replayed")).toBe("true");
    });

    it("should return 422 Unprocessable Entity when same key is reused with a different payload", async () => {
      const req1 = makeReq({ idempotencyKey: "key-tamper", body: { amount: 100 } });
      const res1 = makeRes();

      await runMiddleware(idempotency, req1, res1, () => {
        res1.status(200).json({ status: "success" });
      });

      const req2 = makeReq({ idempotencyKey: "key-tamper", body: { amount: 999 } });
      const res2 = makeRes();

      await runMiddleware(idempotency, req2, res2, () => {
        res2.status(200).json({ status: "should-never-reach" });
      });

      expect(res2.statusCode).toBe(422);
      expect(res2.body).toMatchObject({
        error: "idempotency_key_reuse",
      });
    });
  });

  describe("Concurrency & 409 Conflict Handling", () => {
    it("should return HTTP 409 Conflict when concurrent in-flight request holds the lock", async () => {
      const req1 = makeReq({ idempotencyKey: "concurrent-key" });
      const cacheKey = buildCacheKey(req1, "concurrent-key");
      const lockKey = `${cacheKey}:lock`;

      // Simulate lock already held by an ongoing request
      locks.add(lockKey);

      const res2 = makeRes();
      let executed = false;

      await runMiddleware(idempotency, req1, res2, () => {
        executed = true;
      });

      expect(executed).toBe(false);
      expect(res2.statusCode).toBe(409);
      expect(res2.body).toMatchObject({
        error: "Conflict",
      });
    });

    it("should acquire and release lock via Redlock manager", async () => {
      const req = makeReq({ idempotencyKey: "redlock-key-1" });
      const res = makeRes();

      await runMiddleware(idempotency, req, res, () => {
        res.status(200).json({ processedWithRedlock: true });
      });

      expect(mockLockManager.tryAcquire).toHaveBeenCalled();
      await new Promise((r) => setImmediate(r));
      expect(mockLockManager.release).toHaveBeenCalled();
    });

    it("should serialize concurrent requests: exactly one executes and duplicate receives 409", async () => {
      const key = "simultaneous-race-key";
      const reqA = makeReq({ idempotencyKey: key });
      const reqB = makeReq({ idempotencyKey: key });

      const resA = makeRes();
      const resB = makeRes();

      let handlerExecutions = 0;

      // Launch both requests concurrently
      const promiseA = runMiddleware(idempotency, reqA, resA, async () => {
        handlerExecutions += 1;
        // Simulate in-flight async work
        await new Promise((r) => setTimeout(r, 20));
        resA.status(200).json({ result: "processed-A" });
      });

      const promiseB = runMiddleware(idempotency, reqB, resB, async () => {
        handlerExecutions += 1;
        resB.status(200).json({ result: "processed-B" });
      });

      await Promise.all([promiseA, promiseB]);

      // Exactly one must succeed and the concurrent duplicate must receive 409
      expect(handlerExecutions).toBe(1);
      const statuses = [resA.statusCode, resB.statusCode];
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);
    });
  });

  describe("Lock Release on Error & Abort", () => {
    it("should release distributed lock when handler errors without responding so retries can proceed", async () => {
      const req = makeReq({ idempotencyKey: "error-key-1" });
      const res = makeRes();

      await expect(
        runMiddleware(idempotency, req, res, () => {
          throw new Error("Payment gateway network failure");
        }),
      ).rejects.toThrow("Payment gateway network failure");

      // Trigger finish listeners registered on response
      const finishCbs = res._events["finish"] || [];
      for (const cb of finishCbs) cb();

      await new Promise((r) => setImmediate(r));

      const cacheKey = buildCacheKey(req, "error-key-1");
      const lockKey = `${cacheKey}:lock`;
      expect(locks.has(lockKey)).toBe(false);

      // Verify retry can proceed after lock was released
      const retryRes = makeRes();
      let retryExecuted = false;

      await runMiddleware(idempotency, req, retryRes, () => {
        retryExecuted = true;
        retryRes.status(200).json({ status: "recovered" });
      });

      expect(retryExecuted).toBe(true);
      expect(retryRes.statusCode).toBe(200);
    });
  });

  describe("ioredis and Middleware Factory", () => {
    it("should support getIoRedisClient and setIoRedisClient", () => {
      const mockIo = {} as any;
      setIoRedisClient(mockIo);
      expect(getIoRedisClient()).toBe(mockIo);
      setIoRedisClient(null);
    });

    it("should support custom TTL in createIdempotencyMiddleware", async () => {
      const customMw = createIdempotencyMiddleware({ ttlSeconds: 120, required: true });
      const req = makeReq({ idempotencyKey: "custom-ttl-1" });
      const res = makeRes();

      await runMiddleware(customMw, req, res, () => {
        res.status(200).json({ custom: true });
      });

      await new Promise((r) => setImmediate(r));

      const cacheKey = buildCacheKey(req, "custom-ttl-1");
      const setCalls = mockRedisClient.set.mock.calls.filter((c: unknown[]) => c[0] === cacheKey);
      expect(setCalls.length).toBeGreaterThan(0);
      expect(setCalls[0][2]).toMatchObject({ EX: 120 });
    });
  });
});
