import axios from "axios";
import { createHash } from "crypto";
import { redisClient } from "../../config/redis";
import { lockManager } from "../../utils/lock";
import logger from "../../utils/logger";

export const ECOCASH_REFRESH_WINDOW_MS = 5 * 60_000;
export const ECOCASH_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
export const DEFAULT_ECOCASH_TOKEN_TTL_SECONDS = 3_600;

export interface EcoCashToken {
  accessToken: string;
  expiresAt: number;
}

export interface EcoCashTokenGrant {
  accessToken: string;
  expiresIn: unknown;
}

export interface EcoCashTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface EcoCashLockHandle {
  release(): Promise<void>;
}

export interface EcoCashTokenLock {
  tryAcquire(
    resource: string,
    ttlMs: number,
  ): Promise<EcoCashLockHandle | null>;
}

export interface EcoCashAuthOptions {
  keyId?: string;
  fetchToken: () => Promise<EcoCashTokenGrant>;
  store?: EcoCashTokenStore;
  lock?: EcoCashTokenLock;
  refreshWindowMs?: number;
  lockTtlMs?: number;
  lockWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EcoCashOAuthConfig {
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}

export function isTransientTokenError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { response?: { status?: number }; status?: number };
  const status = e.response?.status ?? e.status;
  return typeof status === "number" && status >= 500 && status < 600;
}

function normalizeExpiresInSeconds(expiresIn: unknown): number {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_ECOCASH_TOKEN_TTL_SECONDS;
}

function parseToken(raw: string | null): EcoCashToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EcoCashToken>;
    if (
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
    }
  } catch {
    return null;
  }
  return null;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const redisEcoCashTokenStore: EcoCashTokenStore = {
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

export const redlockEcoCashTokenLock: EcoCashTokenLock = {
  async tryAcquire(resource, ttlMs) {
    if (!redisClient.isOpen) {
      return { release: async () => undefined };
    }
    const lock = await lockManager.tryAcquire(resource, ttlMs);
    if (!lock) return null;
    return { release: async () => lockManager.release(lock) };
  },
};

export class EcoCashTokenManager {
  readonly cacheKey: string;
  readonly lockResource: string;

  private readonly fetchToken: () => Promise<EcoCashTokenGrant>;
  private readonly store: EcoCashTokenStore;
  private readonly lock: EcoCashTokenLock;
  private readonly refreshWindowMs: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private local: EcoCashToken | null = null;
  private inflight: Promise<EcoCashToken> | null = null;

  constructor(options: EcoCashAuthOptions) {
    const keyId = createHash("sha256")
      .update(options.keyId ?? "default")
      .digest("hex")
      .slice(0, 16);
    this.cacheKey = `ecocash:token:${keyId}`;
    this.lockResource = `ecocash:token-refresh:${keyId}`;

    this.fetchToken = options.fetchToken;
    this.store = options.store ?? redisEcoCashTokenStore;
    this.lock = options.lock ?? redlockEcoCashTokenLock;
    this.refreshWindowMs = options.refreshWindowMs ?? ECOCASH_REFRESH_WINDOW_MS;
    this.lockTtlMs = options.lockTtlMs ?? 10_000;
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getToken(): Promise<string> {
    const local = this.local;
    if (local && this.isFresh(local)) return local.accessToken;
    return (await this.refresh()).accessToken;
  }

  async getAuthorizationHeader(): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

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
        { err: error instanceof Error ? error.message : String(error) },
        "EcoCash: failed to evict cached token",
      );
    }
  }

  private isFresh(token: EcoCashToken): boolean {
    return this.now() < token.expiresAt - this.refreshWindowMs;
  }

  private isUsable(token: EcoCashToken): boolean {
    return this.now() < token.expiresAt;
  }

  private refresh(): Promise<EcoCashToken> {
    if (!this.inflight) {
      this.inflight = this.refreshShared().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async readShared(): Promise<EcoCashToken | null> {
    try {
      return parseToken(await this.store.get(this.cacheKey));
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "EcoCash: token cache read failed",
      );
      return null;
    }
  }

  private async refreshShared(): Promise<EcoCashToken> {
    const shared = await this.readShared();
    if (shared && this.isFresh(shared)) return this.adopt(shared);

    let handle: EcoCashLockHandle | null = null;
    try {
      handle = await this.lock.tryAcquire(this.lockResource, this.lockTtlMs);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "EcoCash: token lock unavailable, refreshing without coordination",
      );
      return this.fetchAndStore();
    }

    if (!handle) {
      let waited = 0;
      while (waited < this.lockWaitMs) {
        await this.sleep(this.pollIntervalMs);
        waited += this.pollIntervalMs;
        const candidate = await this.readShared();
        if (candidate && this.isFresh(candidate)) return this.adopt(candidate);
      }

      const fallback = (await this.readShared()) ?? this.local;
      if (fallback && this.isUsable(fallback)) return this.adopt(fallback);
      return this.fetchAndStore();
    }

    try {
      const recheck = await this.readShared();
      if (recheck && this.isFresh(recheck)) return this.adopt(recheck);
      return await this.fetchAndStore();
    } finally {
      await handle
        .release()
        .catch((error) =>
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "EcoCash: failed to release token lock",
          ),
        );
    }
  }

  private async fetchWithBackoff(): Promise<EcoCashTokenGrant> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= ECOCASH_BACKOFF_DELAYS_MS.length;
      attempt++
    ) {
      try {
        return await this.fetchToken();
      } catch (error) {
        lastError = error;
        if (!isTransientTokenError(error)) throw error;
        const delay = ECOCASH_BACKOFF_DELAYS_MS[attempt];
        if (delay === undefined) break;
        logger.warn(
          { attempt: attempt + 1, delay_ms: delay },
          "EcoCash: token endpoint returned a transient error, retrying",
        );
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  private async fetchAndStore(): Promise<EcoCashToken> {
    const grant = await this.fetchWithBackoff();
    if (!grant.accessToken || typeof grant.accessToken !== "string") {
      throw new Error("EcoCash token response did not include an access token");
    }

    const ttlMs = normalizeExpiresInSeconds(grant.expiresIn) * 1_000;
    const token: EcoCashToken = {
      accessToken: grant.accessToken,
      expiresAt: this.now() + ttlMs,
    };

    try {
      await this.store.set(this.cacheKey, JSON.stringify(token), ttlMs);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "EcoCash: failed to share token in cache",
      );
    }

    return this.adopt(token);
  }

  private adopt(token: EcoCashToken): EcoCashToken {
    this.local = token;
    return token;
  }
}

export function createEcoCashAuth(
  config: EcoCashOAuthConfig = {},
  overrides: Partial<EcoCashAuthOptions> = {},
): EcoCashTokenManager {
  const tokenUrl = config.tokenUrl ?? process.env.ECOCASH_TOKEN_URL ?? "";
  const clientId = config.clientId ?? process.env.ECOCASH_CLIENT_ID ?? "";
  const clientSecret =
    config.clientSecret ?? process.env.ECOCASH_CLIENT_SECRET ?? "";
  const timeoutMs = config.timeoutMs ?? 10_000;

  return new EcoCashTokenManager({
    keyId: clientId || "default",
    fetchToken: async () => {
      if (!tokenUrl) {
        throw new Error("EcoCash token endpoint is not configured");
      }
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
          auth: { username: clientId, password: clientSecret },
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: timeoutMs,
        },
      );
      return {
        accessToken: response.data?.access_token,
        expiresIn: response.data?.expires_in,
      };
    },
    ...overrides,
  });
}
