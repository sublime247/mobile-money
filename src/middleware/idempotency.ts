import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import IORedis from "ioredis";
import { Lock } from "redlock";
import { redisClient } from "../config/redis";
import { lockManager, LockKeys } from "../utils/lock";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------

/** Default TTL for cached idempotent responses: 60 seconds (Issue #2161). */
export const IDEMPOTENCY_TTL_SECONDS = 60;

/** Extended TTL for strict payment idempotency: 24 hours (Issue #1972). */
export const STRICT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Default lock TTL: 10 seconds to allow standard transaction completion. */
export const DEFAULT_LOCK_TTL_MS = 10000;

export const IDEMPOTENCY_PREFIX = "idempotency";

export interface IdempotencyOptions {
  /** TTL in seconds for caching the finalized response (default: 60). */
  ttlSeconds?: number;
  /** In-flight distributed lock TTL in milliseconds (default: 10000). */
  lockTtlMs?: number;
  /** Whether requests missing Idempotency-Key are rejected with 400 (default: false). */
  required?: boolean;
}

export interface CachedIdempotentResponse {
  status: number;
  body: unknown;
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// ioredis client instance support
// ---------------------------------------------------------------------------

let ioRedisInstance: IORedis | null = null;

export function getIoRedisClient(): IORedis {
  if (!ioRedisInstance) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    ioRedisInstance = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    ioRedisInstance.on("error", (err) => {
      logger.debug("[idempotency] ioredis client notice:", err.message);
    });
  }
  return ioRedisInstance;
}

export function setIoRedisClient(client: IORedis | null): void {
  ioRedisInstance = client;
}

// ---------------------------------------------------------------------------
// Key & Fingerprint Utilities
// ---------------------------------------------------------------------------

/**
 * Builds the Redis cache key scoped by user identity (when available)
 * so multiple tenants or users replaying keys cannot cross-contaminate.
 */
export function buildCacheKey(req: Request, key: string): string {
  const identity =
    (req as Request & { jwtUser?: { userId?: string }; user?: { id?: string } })
      .jwtUser?.userId ??
    (req as Request & { user?: { id?: string } }).user?.id ??
    "anonymous";
  const path = req.route?.path || req.baseUrl || req.path || "";
  return `${IDEMPOTENCY_PREFIX}:${identity}:${req.method}:${path}:${key}`;
}

/**
 * Computes a stable SHA-256 fingerprint of the request payload
 * to validate against accidental key reuse with different parameters.
 */
export function fingerprintRequest(req: Request, key: string): string {
  const payload = JSON.stringify({
    key,
    method: req.method,
    path: req.originalUrl || req.url,
    body: req.body ?? {},
    query: req.query ?? {},
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Distributed Locking via Redlock & Redis
// ---------------------------------------------------------------------------

interface AcquiredDistributedLock {
  release: () => Promise<void>;
}

/**
 * Acquires a distributed lock using Redlock algorithm, with fallback
 * to atomic Redis SET NX EX for mock environments and non-eval clients.
 */
async function acquireDistributedLock(
  lockResource: string,
  fingerprint: string,
  lockTtlMs: number,
): Promise<AcquiredDistributedLock | null> {
  const redisLockKey = `${lockResource}:lock`;

  // 1. Try Redlock distributed lock manager if eval is supported
  try {
    if (
      redisClient &&
      typeof (redisClient as any).eval === "function" &&
      lockManager &&
      typeof lockManager.tryAcquire === "function"
    ) {
      const redlockLock = await lockManager.tryAcquire(lockResource, lockTtlMs);
      if (redlockLock) {
        return {
          release: async () => {
            try {
              await lockManager.release(redlockLock);
            } catch (err) {
              logger.debug("[idempotency] Redlock release notice:", err);
            }
          },
        };
      }
      // Contention detected by Redlock
      return null;
    }
  } catch (err) {
    logger.debug("[idempotency] Redlock acquisition failed, attempting atomic SET NX", err);
  }

  // 2. Direct atomic Redis distributed lock: SET key fingerprint NX EX
  try {
    const lockTtlSeconds = Math.ceil(lockTtlMs / 1000);
    const lockAcquired = await redisClient.set(redisLockKey, fingerprint, {
      NX: true,
      EX: lockTtlSeconds,
    });

    if (lockAcquired === "OK" || (lockAcquired as unknown) === true) {
      return {
        release: async () => {
          try {
            await redisClient.del(redisLockKey);
          } catch (err) {
            logger.debug("[idempotency] Redis lock key deletion notice:", err);
          }
        },
      };
    }

    return null;
  } catch (error) {
    logger.error("[idempotency] Redis distributed lock acquisition error:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

/**
 * Creates an idempotency middleware configured with custom TTL and enforcement policies.
 */
export function createIdempotencyMiddleware(options: IdempotencyOptions = {}) {
  const ttlSeconds = options.ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS;
  const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const isRequired = options.required ?? false;

  return async function idempotencyHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const rawKey = req.headers["idempotency-key"] as string | string[] | undefined;
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Handle missing Idempotency-Key header
    if (!key || key.trim() === "") {
      if (isRequired) {
        res.status(400).json({
          error: "invalid_request",
          message:
            "Idempotency-Key header is required for this endpoint. Supply a unique key per logical operation (e.g. a UUID) and reuse it for retries.",
        });
        return;
      }
      return next();
    }

    const cacheKey = buildCacheKey(req, key);
    const fingerprint = fingerprintRequest(req, key);

    try {
      // 1. Check if an identical request was already finalized within the TTL window
      const cachedRaw = (await redisClient.get(cacheKey)) as string | null;
      if (cachedRaw) {
        let cached: CachedIdempotentResponse;
        try {
          cached = JSON.parse(cachedRaw) as CachedIdempotentResponse;
        } catch {
          cached = {
            status: 500,
            body: { error: "Corrupt idempotency cache entry" },
            fingerprint: "",
          };
        }

        // Validate payload fingerprint to prevent accidental key collision/reuse
        if (cached.fingerprint && cached.fingerprint !== fingerprint) {
          res.status(422).json({
            error: "idempotency_key_reuse",
            message:
              "This Idempotency-Key was already used with a different request payload. Use a new key for a new operation.",
          });
          return;
        }

        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.status).json(cached.body);
        return;
      }

      // 2. Acquire Redis distributed lock to guard against concurrent in-flight requests
      const acquiredLock = await acquireDistributedLock(cacheKey, fingerprint, lockTtlMs);
      if (!acquiredLock) {
        res.status(409).json({
          error: "Conflict",
          message:
            "Concurrent request in progress for this idempotency key. Please retry after initial processing completes.",
        });
        return;
      }

      let finished = false;
      const persist = (status: number, body: unknown) => {
        if (finished) return;
        finished = true;

        const record: CachedIdempotentResponse = { status, body, fingerprint };
        void Promise.resolve(
          redisClient.set(cacheKey, JSON.stringify(record), {
            EX: ttlSeconds,
          }),
        )
          .catch((err) =>
            logger.error("[idempotency] Failed to cache idempotent response:", err),
          )
          .finally(() => {
            void acquiredLock.release().catch(() => {});
          });
      };

      const releaseLock = () => {
        if (finished) return;
        finished = true;
        void acquiredLock.release().catch(() => {});
      };

      // Intercept response writers to capture response and release distributed lock
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        persist(res.statusCode, body);
        return originalJson(body);
      };

      const originalSend = res.send.bind(res);
      res.send = (body: unknown) => {
        persist(res.statusCode, body);
        return originalSend(body);
      };

      // Ensure lock is released if response stream aborts or errors without completion
      res.on("finish", releaseLock);
      res.on("close", releaseLock);
    } catch (error) {
      logger.error(
        "[idempotency] Redis error encountered, continuing without idempotency guarantee:",
        error,
      );
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Standard Middleware Exports
// ---------------------------------------------------------------------------

/**
 * Standard idempotency middleware utilizing Redlock / Redis distributed locking (Issue #2161).
 * Features a 60 second TTL for cached responses and 409 Conflict rejection for concurrent executions.
 */
export const idempotency = createIdempotencyMiddleware({
  required: false,
  ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
  lockTtlMs: DEFAULT_LOCK_TTL_MS,
});

/**
 * Strict idempotency middleware requiring the Idempotency-Key header with a 24-hour TTL (Issue #1972).
 */
export const strictIdempotency = createIdempotencyMiddleware({
  required: true,
  ttlSeconds: STRICT_IDEMPOTENCY_TTL_SECONDS,
  lockTtlMs: DEFAULT_LOCK_TTL_MS,
});

export const idempotentTransaction = idempotency;
export const idempotencyMiddleware = idempotency;
export default idempotency;