import { Request, Response, NextFunction } from "express";
import { queryWrite, queryRead, getPoolClient } from "../config/database";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";
import { lockManager, isLockAcquisitionError, LockKeys } from "../utils/lock";
import crypto from "crypto";
import type { Lock } from "redlock";

// Ensure idempotency table exists
async function ensureIdempotencyTable() {
  await queryWrite(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key VARCHAR(255) PRIMARY KEY,
      status VARCHAR(50) NOT NULL,
      response_status INTEGER,
      response_body JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `, []);
}

// Ensure table exists on load
ensureIdempotencyTable().catch(err => logger.error("Failed to ensure idempotency table", err));

export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["idempotency-key"] as string;
  if (!key) {
    return next();
  }

  // Generate a numeric hash for the advisory lock to prevent race conditions during insertion
  const hash = crypto.createHash("md5").update(key).digest("hex");
  const lockId = parseInt(hash.substring(0, 8), 16);

  const client = await getPoolClient();
  try {
    // 1. Check Transaction Locks on request starts
    const lockResult = await client.query("SELECT pg_try_advisory_lock($1) as locked", [lockId]);
    const locked = lockResult.rows[0].locked;

    if (!locked) {
      return res.status(409).json({ error: "Concurrent request in progress for this idempotency key" });
    }

    // 2. Check if key already exists
    const recordResult = await client.query("SELECT * FROM idempotency_keys WHERE key = $1", [key]);
    if (recordResult.rows.length > 0) {
      const record = recordResult.rows[0];
      // 3. Duplicate execution requests return original result
      if (record.status === "completed") {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        client.release();
        return res.status(record.response_status).json(record.response_body);
      } else if (record.status === "processing") {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        client.release();
        return res.status(409).json({ error: "Request currently processing" });
      }
    } else {
      await client.query(
        "INSERT INTO idempotency_keys (key, status) VALUES ($1, 'processing')",
        [key]
      );
    }

    // Wrap the response to capture finalization state
    const originalSend = res.send.bind(res);
    res.send = (body: any) => {
      // 2. Release locks only on request finalization states (by storing response and unlocking)
      let parsedBody = body;
      try {
        parsedBody = typeof body === "string" ? JSON.parse(body) : body;
      } catch (e) {
        parsedBody = { data: body };
      }

      client.query(
        "UPDATE idempotency_keys SET status = 'completed', response_status = $1, response_body = $2, updated_at = CURRENT_TIMESTAMP WHERE key = $3",
        [res.statusCode, JSON.stringify(parsedBody), key]
      ).finally(() => {
        client.query("SELECT pg_advisory_unlock($1)", [lockId]).finally(() => {
          client.release();
        });
      });

      return originalSend(body);
    };

    next();
  } catch (error) {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    client.release();
    next(error);
  }
}

// ============================================================================
// Strict Redis-backed idempotency (issue #1972)
// ============================================================================

/** TTL for cached idempotent responses: 24 hours. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** TTL for the in-flight lock: generous enough for long payment flows. */
const LOCK_TTL_SECONDS = 60;

const IDEMPOTENCY_PREFIX = "idempotency";

interface CachedIdempotentResponse {
  status: number;
  body: unknown;
  fingerprint: string;
}

/**
 * Builds the Redis cache key. Scoped by identity (when available) so one
 * client replaying a key cannot observe another client's response.
 */
function buildCacheKey(req: Request, key: string): string {
  const identity =
    (req as Request & { jwtUser?: { userId?: string }; user?: { id?: string } })
      .jwtUser?.userId ??
    (req as Request & { user?: { id?: string } }).user?.id ??
    "anonymous";
  return `${IDEMPOTENCY_PREFIX}:${identity}:${req.method}:${req.baseUrl || ""}${req.route?.path || req.path}:${key}`;
}

/** Stable fingerprint of the request payload for replay validation. */
function fingerprintRequest(req: Request, key: string): string {
  // Multipart uploads (e.g. bulk CSV) carry their payload in req.file, not
  // req.body, so hash the file contents too.
  const file = (req as Request & { file?: { buffer?: Buffer } }).file;
  const payload = JSON.stringify({
    key,
    method: req.method,
    path: req.originalUrl,
    body: req.body ?? {},
    query: req.query ?? {},
    file: file?.buffer
      ? crypto.createHash("sha256").update(file.buffer).digest("hex")
      : undefined,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Strict idempotency middleware for state-mutating payment endpoints
 * (issue #1972).
 *
 * Behaviour:
 * - Rejects requests missing the `Idempotency-Key` header (400).
 * - First request: executes normally and caches the response in Redis
 *   with a 24-hour TTL.
 * - Duplicate request (same key + same payload): replays the identical
 *   cached response without re-executing the handler.
 * - Duplicate request with a *different* payload under the same key:
 *   rejected with 422 to prevent accidental key reuse.
 * - Concurrent duplicate while the first is still executing: 409. The
 *   in-flight lock is a Redlock distributed lock (see `utils/lock`), and the
 *   cache is re-checked once the lock is held so a duplicate that raced past
 *   the first lookup replays instead of re-executing.
 *
 * Applied to POST /transactions (deposit/withdraw), POST /sep31/transactions
 * and bulk payouts — see `src/routes/transactions.ts`,
 * `src/routes/v1/transactions.ts`, `src/stellar/sep31.ts` and
 * `src/routes/bulk.ts`. Provider webhooks use `optionalIdempotency`.
 */
export async function strictIdempotency(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawKey = req.headers["idempotency-key"] as string | string[] | undefined;
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (!key || key.trim() === "") {
    res.status(400).json({
      error: "invalid_request",
      message:
        "Idempotency-Key header is required for this endpoint. Supply a unique key per logical operation (e.g. a UUID) and reuse it for retries.",
    });
    return;
  }

  const cacheKey = buildCacheKey(req, key);
  const fingerprint = fingerprintRequest(req, key);
  const lockResource = LockKeys.idempotency(
    crypto.createHash("sha256").update(cacheKey).digest("hex"),
  );

  try {
    // Replays the cached response (or rejects a mismatched payload) and
    // reports whether the request was answered.
    const replayIfCached = async (): Promise<boolean> => {
      const cachedRaw = (await redisClient.get(cacheKey)) as string | null;
      if (!cachedRaw) return false;

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

      if (cached.fingerprint && cached.fingerprint !== fingerprint) {
        res.status(422).json({
          error: "idempotency_key_reuse",
          message:
            "This Idempotency-Key was already used with a different request payload. Use a new key for a new operation.",
        });
        return true;
      }

      res.setHeader("Idempotency-Replayed", "true");
      res.status(cached.status).json(cached.body);
      return true;
    };

    // 1. Return the cached response for an exact duplicate.
    if (await replayIfCached()) return;

    // 2. Guard against concurrent duplicates while the first executes.
    let lock: Lock;
    try {
      lock = await lockManager.acquire(lockResource, LOCK_TTL_SECONDS * 1000);
    } catch (lockError) {
      if (isLockAcquisitionError(lockError) && lockError.isContention) {
        res.status(409).json({
          error: "idempotency_key_in_progress",
          message:
            "A request with this Idempotency-Key is currently in progress. Retry later — the original response will be returned once it completes.",
        });
        return;
      }
      throw lockError;
    }

    // 3. The first request may have finished between the lookup above and
    // acquiring the lock; re-check so it is replayed, not executed twice.
    try {
      if (await replayIfCached()) {
        await lockManager.release(lock).catch(() => {});
        return;
      }
    } catch (recheckError) {
      await lockManager.release(lock).catch(() => {});
      throw recheckError;
    }

    let finished = false;
    const persist = (status: number, body: unknown) => {
      if (finished) return;
      finished = true;
      const record: CachedIdempotentResponse = { status, body, fingerprint };
      void Promise.resolve(
        redisClient.set(cacheKey, JSON.stringify(record), {
          EX: IDEMPOTENCY_TTL_SECONDS,
        }),
      )
        .catch((err) =>
          logger.error("[idempotency] Failed to cache response", err),
        )
        .finally(() => {
          void lockManager.release(lock).catch(() => {});
        });
    };

    const releaseLock = () => {
      if (finished) return;
      finished = true;
      void lockManager.release(lock).catch(() => {});
    };

    // Capture both JSON and raw send paths so the exact response is cached.
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

    // Release the lock when the response cycle ends without a captured
    // response (e.g. the handler threw and the error path took over), so a
    // client retry is not permanently blocked by a stale in-flight lock.
    res.on("finish", releaseLock);
    res.on("close", releaseLock);
  } catch (error) {
    // Redis unavailable — never block the payment path; proceed unsafely
    // but log loudly so the incident is observable.
    logger.error(
      "[idempotency] Redis unavailable, proceeding without idempotency guarantee",
      error,
    );
  }

  // Invoked outside the Redis try/catch so handler errors propagate to
  // Express's error handler normally and are never mistaken for a cache
  // outage. The in-flight lock is released by the finish/close listeners
  // registered above when the response cycle ends without a cached reply.
  next();
}

/**
 * Idempotency for endpoints where the header is optional, such as provider
 * webhooks and callbacks. Requests without an `Idempotency-Key` pass straight
 * through; requests with one get the full `strictIdempotency` behaviour.
 */
export function optionalIdempotency(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> | void {
  const rawKey = req.headers["idempotency-key"] as
    string | string[] | undefined;
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (!key || key.trim() === "") {
    return next();
  }

  return strictIdempotency(req, res, next);
}
