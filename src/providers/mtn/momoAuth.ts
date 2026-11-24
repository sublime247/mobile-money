/**
 * MTN MoMo OAuth2 token manager
 *
 * Every MTN MoMo API call needs a short-lived Bearer token obtained from
 * `POST /{product}/token/`. With several API replicas each keeping its own
 * in-memory token, a cold start or a simultaneous expiry makes every replica
 * hit the token endpoint at once (a "token stampede"), which MTN rate-limits.
 *
 * `MomoAuthManager` fixes that by layering three caches:
 *
 *   1. An in-process copy of the token (fast path, no I/O).
 *   2. A shared copy in Redis, so replicas reuse one token.
 *   3. A Redlock-guarded refresh, so only one replica calls MTN when the
 *      shared token is missing or inside its refresh window. The others wait
 *      for the new token to land in Redis instead of fetching their own.
 *
 * Tokens are refreshed *before* they expire: once a token enters the refresh
 * window callers keep using it while a single background refresh runs.
 *
 * When MTN rejects a token with 401 (revoked, rotated credentials, clock
 * skew), {@link MomoAuthManager.withAuthRetry} evicts it from both caches and
 * retries the call once with a fresh token.
 *
 * If Redis is unavailable the manager degrades to per-process caching with
 * in-process single-flight, which is the pre-existing behaviour.
 */

import { createHash } from "crypto";
import { redisClient } from "../../config/redis";
import { lockManager } from "../../utils/lock";
import logger from "../../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MomoProduct = "collection" | "disbursement" | "remittance";

export interface MomoToken {
  accessToken: string;
  /** Epoch ms after which MTN will reject the token. */
  expiresAt: number;
}

export interface MomoTokenResponse {
  accessToken: string;
  /** Token lifetime in seconds, as reported by MTN (`expires_in`). */
  expiresIn: unknown;
}

/** Shared token cache (Redis in production). */
export interface MomoTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface MomoLockHandle {
  release(): Promise<void>;
}

/** Distributed lock (Redlock in production). */
export interface MomoTokenLock {
  /** Acquire without retrying; resolves `null` if another holder has it. */
  tryAcquire(resource: string, ttlMs: number): Promise<MomoLockHandle | null>;
}

export interface MomoAuthOptions {
  product: MomoProduct;
  apiKey: string;
  targetEnvironment: string;
  /** Performs the actual `POST /{product}/token/` exchange. */
  fetchToken: () => Promise<MomoTokenResponse>;
  store?: MomoTokenStore;
  lock?: MomoTokenLock;
  /** Refresh this long before expiry (default 60 s). */
  refreshWindowMs?: number;
  /** Lock TTL; must exceed a token round-trip (default 10 s). */
  lockTtlMs?: number;
  /** How long a non-leader waits for the leader's token (default 5 s). */
  lockWaitMs?: number;
  /** Poll interval while waiting on the leader (default 100 ms). */
  pollIntervalMs?: number;
  /** Clock, overridable in tests. */
  now?: () => number;
}

/** Fallback lifetime when MTN omits or garbles `expires_in` (MTN default). */
export const DEFAULT_MOMO_TOKEN_TTL_SECONDS = 3600;

const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const DEFAULT_LOCK_TTL_MS = 10_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** True when an error is an HTTP 401 from the provider (axios or fetch-like). */
export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    response?: { status?: number };
    status?: number;
    statusCode?: number;
  };
  return e.response?.status === 401 || e.status === 401 || e.statusCode === 401;
}

function normalizeExpiresInSeconds(expiresIn: unknown): number {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_MOMO_TOKEN_TTL_SECONDS;
}

function parseToken(raw: string | null): MomoToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MomoToken>;
    if (
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
    }
  } catch {
    // Corrupt cache entry — treat as a miss.
  }
  return null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── Default Redis-backed implementations ─────────────────────────────────────

/**
 * Token store on the shared node-redis client. Reports a miss (and skips
 * writes) whenever the client is not connected, so callers fall back to
 * per-process caching instead of failing.
 */
export const redisMomoTokenStore: MomoTokenStore = {
  async get(key) {
    if (!redisClient.isOpen) return null;
    const value = await redisClient.get(key);
    return value == null ? null : String(value);
  },
  async set(key, value, ttlMs) {
    if (!redisClient.isOpen) return;
    await redisClient.set(key, value, {
      expiration: { type: "PX", value: Math.max(1, Math.floor(ttlMs)) },
    });
  },
  async del(key) {
    if (!redisClient.isOpen) return;
    await redisClient.del(key);
  },
};

/**
 * Redlock-backed lock. Without Redis there is nothing to coordinate with, so
 * the caller is treated as the sole leader.
 */
export const redlockMomoTokenLock: MomoTokenLock = {
  async tryAcquire(resource, ttlMs) {
    if (!redisClient.isOpen) {
      return { release: async () => undefined };
    }
    const lock = await lockManager.tryAcquire(resource, ttlMs);
    if (!lock) return null;
    return {
      release: async () => {
        await lockManager.release(lock);
      },
    };
  },
};

// ─── Manager ──────────────────────────────────────────────────────────────────

export class MomoAuthManager {
  readonly cacheKey: string;
  readonly lockResource: string;

  private readonly fetchToken: () => Promise<MomoTokenResponse>;
  private readonly store: MomoTokenStore;
  private readonly lock: MomoTokenLock;
  private readonly refreshWindowMs: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private local: MomoToken | null = null;
  private inflight: Promise<MomoToken> | null = null;

  constructor(options: MomoAuthOptions) {
    // Scope the cache per product, environment and API user so different
    // credentials never share (or evict) each other's tokens. The API key is
    // hashed so it never appears in Redis key listings.
    const keyId = createHash("sha256")
      .update(options.apiKey)
      .digest("hex")
      .slice(0, 16);
    const scope = `${options.product}:${options.targetEnvironment}:${keyId}`;
    this.cacheKey = `mtn:momo:token:${scope}`;
    this.lockResource = `mtn:momo:token-refresh:${scope}`;

    this.fetchToken = options.fetchToken;
    this.store = options.store ?? redisMomoTokenStore;
    this.lock = options.lock ?? redlockMomoTokenLock;
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns a usable Bearer token.
   *
   * - Fresh token: returned immediately.
   * - Token inside the refresh window but not expired: returned immediately
   *   while one background refresh replaces it.
   * - No token / expired token: waits for a refresh.
   */
  async getToken(): Promise<string> {
    const local = this.local;
    if (local && this.isFresh(local)) return local.accessToken;

    if (local && this.isUsable(local)) {
      this.refresh().catch((error) =>
        logger.warn(
          { err: error instanceof Error ? error.message : error },
          "MTN MoMo: background token refresh failed; using current token",
        ),
      );
      return local.accessToken;
    }

    return (await this.refresh()).accessToken;
  }

  /**
   * Evicts a token MTN rejected. When `rejectedToken` is given, the shared
   * copy is only deleted if it is still that token, so a replica holding a
   * stale token cannot evict a newer one another replica just stored.
   */
  async invalidate(rejectedToken?: string): Promise<void> {
    if (!rejectedToken || this.local?.accessToken === rejectedToken) {
      this.local = null;
    }

    try {
      if (rejectedToken) {
        const shared = parseToken(await this.store.get(this.cacheKey));
        if (shared && shared.accessToken !== rejectedToken) return;
      }
      await this.store.del(this.cacheKey);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "MTN MoMo: failed to evict shared token",
      );
    }
  }

  /**
   * Runs `call` with a Bearer token. If MTN answers 401, the token is
   * invalidated everywhere and the call is retried exactly once with a newly
   * fetched token. Any other error — or a second 401 — is rethrown.
   *
   * @param getToken Token source; defaults to {@link getToken}. Providers pass
   *                 their own `getAccessToken` so it stays the single seam.
   */
  async withAuthRetry<T>(
    call: (token: string) => Promise<T>,
    getToken: () => Promise<string> = () => this.getToken(),
  ): Promise<T> {
    const token = await getToken();
    try {
      return await call(token);
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error;

      logger.warn(
        "MTN MoMo: provider returned 401, invalidating token and retrying",
      );
      await this.invalidate(token);
      let retryToken = await getToken();
      // A refresh already in flight may have read the rejected token back
      // from the shared cache before we evicted it.
      if (retryToken === token) {
        retryToken = (await this.fetchAndStore()).accessToken;
      }
      return call(retryToken);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private isUsable(token: MomoToken): boolean {
    return this.now() < token.expiresAt;
  }

  private isFresh(token: MomoToken): boolean {
    return this.now() < token.expiresAt - this.refreshWindowMs;
  }

  /** Single-flight wrapper: concurrent callers in this process share one refresh. */
  private refresh(): Promise<MomoToken> {
    if (!this.inflight) {
      this.inflight = this.refreshShared().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refreshShared(): Promise<MomoToken> {
    const shared = await this.readShared();
    if (shared && this.isFresh(shared)) return this.adopt(shared);

    let handle: MomoLockHandle | null = null;
    try {
      handle = await this.lock.tryAcquire(this.lockResource, this.lockTtlMs);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "MTN MoMo: token lock unavailable, refreshing without coordination",
      );
      return this.fetchAndStore();
    }

    if (handle) {
      try {
        // Another replica may have refreshed between our read and the lock.
        const recheck = await this.readShared();
        if (recheck && this.isFresh(recheck)) return this.adopt(recheck);
        return await this.fetchAndStore();
      } finally {
        await handle
          .release()
          .catch((error) =>
            logger.warn(
              { err: error instanceof Error ? error.message : error },
              "MTN MoMo: failed to release token lock",
            ),
          );
      }
    }

    // Another replica is refreshing: wait for its token rather than
    // stampeding the token endpoint ourselves.
    const deadline = this.now() + this.lockWaitMs;
    while (this.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const candidate = await this.readShared();
      if (candidate && this.isFresh(candidate)) return this.adopt(candidate);
    }

    // The leader is slow or died holding the lock. A still-valid token is
    // good enough; otherwise fetch our own so callers are not blocked.
    const fallback = (await this.readShared()) ?? this.local;
    if (fallback && this.isUsable(fallback)) return this.adopt(fallback);

    logger.warn(
      "MTN MoMo: timed out waiting for token refresh leader, fetching directly",
    );
    return this.fetchAndStore();
  }

  private async fetchAndStore(): Promise<MomoToken> {
    const { accessToken, expiresIn } = await this.fetchToken();
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("MTN token response did not include access_token");
    }

    const ttlMs = normalizeExpiresInSeconds(expiresIn) * 1_000;
    const token: MomoToken = { accessToken, expiresAt: this.now() + ttlMs };

    try {
      await this.store.set(this.cacheKey, JSON.stringify(token), ttlMs);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "MTN MoMo: failed to share token in cache",
      );
    }

    return this.adopt(token);
  }

  private async readShared(): Promise<MomoToken | null> {
    try {
      return parseToken(await this.store.get(this.cacheKey));
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "MTN MoMo: token cache read failed",
      );
      return null;
    }
  }

  private adopt(token: MomoToken): MomoToken {
    this.local = token;
    return token;
  }
}
