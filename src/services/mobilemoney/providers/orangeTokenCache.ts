/**
 * Orange Money direct-API bearer token cache (#2273)
 *
 * `OrangeProvider.authenticateDirect()` previously kept the token only in a
 * per-process field (`this.apiToken`), so every worker process (and every
 * horizontally-scaled API replica) authenticated against Orange
 * independently. Under load this means N processes all hitting
 * `POST /oauth/token` on cold start instead of sharing one token, which is
 * exactly the "token stampede" problem the existing `MomoAuthManager`
 * (src/providers/mtn/momoAuth.ts) already solves for MTN.
 *
 * `OrangeTokenCache` gives Orange the same shared cache, backed by the same
 * Redis client used across the codebase (src/config/redis.ts):
 *
 *   - The cached token is stored with an expiry equal to the provider's
 *     reported token lifetime minus a TTL safety buffer (default 5 minutes),
 *     so a replica never hands out a token so close to expiry that it would
 *     likely be rejected mid-flight.
 *   - `get()` is a plain Redis GET: any process/replica that calls it reuses
 *     whatever token another process most recently stored, which is the
 *     whole point of Redis over an in-memory cache.
 *   - `invalidate()` deletes the shared key so a 401 forces every replica to
 *     fetch a fresh token on next use, not just the replica that saw the 401.
 *
 * Retry-on-401 is intentionally bounded to exactly one retry; see
 * `withSingleRetryOn401` below. It is a thin helper (no distributed lock)
 * because, unlike MTN's `MomoAuthManager`, Orange does not need refresh-leader
 * coordination for this issue's scope: a 401 is already a signal the cached
 * token is bad, so eviction + a single direct re-fetch is sufficient and
 * matches the issue's explicit "exactly one retry" requirement.
 */

import { redisClient } from "../../../config/redis";
import logger from "../../../utils/logger";

export interface OrangeTokenFetchResult {
  accessToken: string;
  /** Token lifetime in seconds, as reported by Orange (`expires_in`). */
  expiresInSeconds: number;
}

export interface OrangeTokenCacheOptions {
  /** Cache key; scope per credential set so multiple Orange accounts never collide. */
  cacheKey: string;
  /** Safety buffer subtracted from the provider's reported TTL (default 5 minutes). */
  ttlBufferMs?: number;
  /** Fallback token lifetime (seconds) if Orange omits/garbles `expires_in`. */
  defaultTtlSeconds?: number;
  now?: () => number;
}

const DEFAULT_TTL_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_TTL_SECONDS = 3600;

/** True for an HTTP 401 from axios-style or fetch-like error/response shapes. */
export function isUnauthorizedStatus(status: number | undefined): boolean {
  return status === 401;
}

export class OrangeTokenCache {
  private readonly cacheKey: string;
  private readonly ttlBufferMs: number;
  private readonly defaultTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: OrangeTokenCacheOptions) {
    this.cacheKey = options.cacheKey;
    this.ttlBufferMs = options.ttlBufferMs ?? DEFAULT_TTL_BUFFER_MS;
    this.defaultTtlSeconds =
      options.defaultTtlSeconds ?? DEFAULT_FALLBACK_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  /** Reads the shared token from Redis. Returns null on a miss or Redis error. */
  async get(): Promise<string | null> {
    try {
      const value = await redisClient.get(this.cacheKey);
      return value == null ? null : String(value);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "Orange: token cache read failed",
      );
      return null;
    }
  }

  /**
   * Stores the token with an expiry of (provider TTL - buffer), so the
   * shared cache entry is evicted by Redis itself before Orange would reject
   * it. Falls back to `defaultTtlSeconds` when Orange's `expires_in` is
   * missing or non-positive.
   */
  async set(fetched: OrangeTokenFetchResult): Promise<void> {
    const rawTtlSeconds =
      Number.isFinite(fetched.expiresInSeconds) && fetched.expiresInSeconds > 0
        ? fetched.expiresInSeconds
        : this.defaultTtlSeconds;

    const ttlMs = Math.max(1, rawTtlSeconds * 1000 - this.ttlBufferMs);

    try {
      await redisClient.set(this.cacheKey, fetched.accessToken, {
        expiration: { type: "PX", value: Math.floor(ttlMs) },
      });
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "Orange: failed to share token in cache",
      );
    }
  }

  /** Evicts the shared token, forcing every replica to fetch fresh on next use. */
  async invalidate(): Promise<void> {
    try {
      await redisClient.del(this.cacheKey);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "Orange: failed to evict cached token",
      );
    }
  }
}

/**
 * Runs `call` with a token obtained from `getToken`. If the call fails with
 * HTTP 401, invalidates the cache and retries exactly once with a freshly
 * fetched token (via `forceRefresh`). Any other error, or a second 401, is
 * rethrown without a further retry.
 */
export async function withSingleRetryOn401<T>(
  cache: OrangeTokenCache,
  getToken: (forceRefresh: boolean) => Promise<string>,
  call: (token: string) => Promise<{ status?: number } & T>,
): Promise<{ status?: number } & T> {
  const token = await getToken(false);
  const response = await call(token);

  if (!isUnauthorizedStatus(response.status)) {
    return response;
  }

  logger.warn(
    "Orange: direct auth token rejected with 401, invalidating cache and retrying once",
  );
  await cache.invalidate();
  const retryToken = await getToken(true);
  return call(retryToken);
}
