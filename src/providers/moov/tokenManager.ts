/**
 * Moov Africa B2B OAuth token manager (#2366)
 *
 * Moov Africa's B2B API uses Bearer auth with a 3600s token lifetime.
 * `MoovTokenManager` mirrors `../mtn/momoAuth.ts`'s MomoAuthManager design
 * (in-process cache -> shared Redis cache -> Redlock-guarded refresh) rather
 * than re-deriving it, since the two providers have the same "many
 * replicas, one shared short-lived Bearer token" shape. What's different
 * here, per this issue's acceptance criteria:
 *
 *   - Refreshes 5 minutes (not MTN's 60s) before expiry by default, per the
 *     issue's "5 minutes prior to expiration" requirement.
 *   - Supports refresh-token-grant rotation: if a stored refresh token is
 *     present, a refresh uses it first and falls back to a full
 *     client-credentials grant when the provider rejects it (invalid_grant),
 *     e.g. because the refresh token itself expired or was revoked.
 *
 * If Redis/Redlock is unavailable, the manager degrades to per-process
 * caching with in-process single-flight -- the same fallback MTN's manager
 * uses -- rather than failing outright.
 */

import { createHash } from "crypto";
import { redisClient } from "../../config/redis";
import { lockManager } from "../../utils/lock";
import logger from "../../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MoovToken {
  accessToken: string;
  /** Epoch ms after which Moov will reject the token. */
  expiresAt: number;
  /** Present when Moov's grant response included a rotatable refresh token. */
  refreshToken?: string;
}

export interface MoovTokenGrantResponse {
  accessToken: string;
  /** Token lifetime in seconds, as reported by Moov (`expires_in`). */
  expiresIn: unknown;
  refreshToken?: string;
}

/** Shared token cache (Redis in production). */
export interface MoovTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface MoovLockHandle {
  release(): Promise<void>;
}

/** Distributed lock (Redlock in production). */
export interface MoovTokenLock {
  /** Acquire without retrying; resolves `null` if another holder has it. */
  tryAcquire(resource: string, ttlMs: number): Promise<MoovLockHandle | null>;
}

export interface MoovAuthOptions {
  /** Moov API client ID; used only to scope the cache key, never logged. */
  clientId: string;
  clientSecret: string;
  /** Performs a full client-credentials grant exchange. */
  fetchToken: () => Promise<MoovTokenGrantResponse>;
  /**
   * Performs a refresh-token-grant exchange. Receives the refresh token to
   * use and must throw an error whose message/response marks it as an
   * invalid/expired grant (see {@link isInvalidGrantError}) so the manager
   * knows to fall back to {@link MoovAuthOptions.fetchToken} instead of
   * surfacing the failure to the caller.
   */
  refreshWithToken?: (
    refreshToken: string,
  ) => Promise<MoovTokenGrantResponse>;
  store?: MoovTokenStore;
  lock?: MoovTokenLock;
  /** Refresh this long before expiry (default 5 minutes, per #2366). */
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

/** Fallback lifetime when Moov omits or garbles `expires_in` (per #2366). */
export const DEFAULT_MOOV_TOKEN_TTL_SECONDS = 3600;

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60_000;
const DEFAULT_LOCK_TTL_MS = 10_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * True when a refresh-token-grant exchange was rejected as an invalid grant
 * (expired/revoked refresh token), per OAuth2's `invalid_grant` error code
 * or an HTTP 400/401 on the refresh call.
 */
export function isInvalidGrantError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    response?: { status?: number; data?: { error?: string } };
    status?: number;
    code?: string;
    message?: string;
  };
  if (e.response?.data?.error === "invalid_grant") return true;
  if (e.code === "invalid_grant") return true;
  if (/invalid_grant/i.test(e.message ?? "")) return true;
  const status = e.response?.status ?? e.status;
  return status === 400 || status === 401;
}

function normalizeExpiresInSeconds(expiresIn: unknown): number {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_MOOV_TOKEN_TTL_SECONDS;
}

function parseToken(raw: string | null): MoovToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MoovToken>;
    if (
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return {
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
        refreshToken:
          typeof parsed.refreshToken === "string"
            ? parsed.refreshToken
            : undefined,
      };
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
export const redisMoovTokenStore: MoovTokenStore = {
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
export const redlockMoovTokenLock: MoovTokenLock = {
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

export class MoovTokenManager {
  readonly cacheKey: string;
  readonly lockResource: string;

  private readonly fetchToken: () => Promise<MoovTokenGrantResponse>;
  private readonly refreshWithToken?: (
    refreshToken: string,
  ) => Promise<MoovTokenGrantResponse>;
  private readonly store: MoovTokenStore;
  private readonly lock: MoovTokenLock;
  private readonly refreshWindowMs: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private local: MoovToken | null = null;
  private inflight: Promise<MoovToken> | null = null;

  constructor(options: MoovAuthOptions) {
    // Scope the cache per client, so different credentials never share (or
    // evict) each other's tokens. The secret is never used in the key; the
    // client ID is hashed so it never appears in Redis key listings.
    const keyId = createHash("sha256")
      .update(options.clientId)
      .digest("hex")
      .slice(0, 16);
    this.cacheKey = `moov:token:${keyId}`;
    this.lockResource = `moov:token-refresh:${keyId}`;

    this.fetchToken = options.fetchToken;
    this.refreshWithToken = options.refreshWithToken;
    this.store = options.store ?? redisMoovTokenStore;
    this.lock = options.lock ?? redlockMoovTokenLock;
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
          "Moov: background token refresh failed; using current token",
        ),
      );
      return local.accessToken;
    }

    return (await this.refresh()).accessToken;
  }

  /**
   * Evicts a token Moov rejected. When `rejectedToken` is given, the shared
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
        "Moov: failed to evict shared token",
      );
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private isUsable(token: MoovToken): boolean {
    return this.now() < token.expiresAt;
  }

  private isFresh(token: MoovToken): boolean {
    return this.now() < token.expiresAt - this.refreshWindowMs;
  }

  /** Single-flight wrapper: concurrent callers in this process share one refresh. */
  private refresh(): Promise<MoovToken> {
    if (!this.inflight) {
      this.inflight = this.refreshShared().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refreshShared(): Promise<MoovToken> {
    const shared = await this.readShared();
    if (shared && this.isFresh(shared)) return this.adopt(shared);

    let handle: MoovLockHandle | null = null;
    try {
      handle = await this.lock.tryAcquire(this.lockResource, this.lockTtlMs);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "Moov: token lock unavailable, refreshing without coordination",
      );
      return this.fetchAndStore(shared?.refreshToken);
    }

    if (handle) {
      try {
        // Another replica may have refreshed between our read and the lock.
        const recheck = await this.readShared();
        if (recheck && this.isFresh(recheck)) return this.adopt(recheck);
        return await this.fetchAndStore(recheck?.refreshToken ?? shared?.refreshToken);
      } finally {
        await handle
          .release()
          .catch((error) =>
            logger.warn(
              { err: error instanceof Error ? error.message : error },
              "Moov: failed to release token lock",
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
      "Moov: timed out waiting for token refresh leader, fetching directly",
    );
    return this.fetchAndStore(shared?.refreshToken);
  }

  /**
   * Exchanges for a new token. Tries the refresh-token grant first when a
   * rotatable refresh token is available and the caller supplied
   * `refreshWithToken`; falls back to a full client-credentials grant on
   * `invalid_grant` (expired/revoked refresh token) or when no refresh
   * token/handler is available at all.
   */
  private async fetchAndStore(
    refreshToken?: string,
  ): Promise<MoovToken> {
    let grant: MoovTokenGrantResponse;

    if (refreshToken && this.refreshWithToken) {
      try {
        grant = await this.refreshWithToken(refreshToken);
      } catch (error) {
        if (!isInvalidGrantError(error)) throw error;
        logger.warn(
          "Moov: refresh token rejected as invalid grant, falling back to client credentials",
        );
        grant = await this.fetchToken();
      }
    } else {
      grant = await this.fetchToken();
    }

    if (!grant.accessToken || typeof grant.accessToken !== "string") {
      throw new Error("Moov token response did not include an access token");
    }

    const ttlMs = normalizeExpiresInSeconds(grant.expiresIn) * 1_000;
    const token: MoovToken = {
      accessToken: grant.accessToken,
      expiresAt: this.now() + ttlMs,
      refreshToken: grant.refreshToken,
    };

    try {
      await this.store.set(this.cacheKey, JSON.stringify(token), ttlMs);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "Moov: failed to share token in cache",
      );
    }

    return this.adopt(token);
  }

  private async readShared(): Promise<MoovToken | null> {
    try {
      return parseToken(await this.store.get(this.cacheKey));
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        "Moov: token cache read failed",
      );
      return null;
    }
  }

  private adopt(token: MoovToken): MoovToken {
    this.local = token;
    return token;
  }
}
