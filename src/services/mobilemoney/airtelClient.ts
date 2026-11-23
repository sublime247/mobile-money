import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { redisClient } from "../../config/redis";
import logger from "../../utils/logger";

export interface AirtelTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

export interface AirtelClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  clientId?: string;
  countryCode?: string;
  currency?: string;
  httpClient?: AxiosInstance;
  proactiveBufferSeconds?: number; // default: 60 seconds
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 200ms
  maxDelayMs?: number; // default: 5000ms
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  redis?: {
    isOpen?: boolean;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, options?: any) => Promise<any>;
    del: (key: string) => Promise<any>;
  };
}

/**
 * Calculates exponential backoff with randomized full jitter:
 * delay = random(0, min(maxDelay, baseDelay * 2^attempt))
 */
export function calculateJitteredBackoff(
  attempt: number,
  baseDelayMs: number = 200,
  maxDelayMs: number = 5000,
): number {
  const maxForAttempt = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * maxForAttempt);
}

/**
 * Manages OAuth2 access tokens for Airtel Money direct integration:
 * - Caches in Redis with TTL = expires_in - 60s (proactive refresh buffer)
 * - Proactively refreshes tokens before expiry
 * - Deduplicates concurrent refresh calls using a single in-flight promise
 * - Exponential backoff with randomized jitter on token errors and HTTP 429
 */
export class AirtelTokenManager {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly proactiveBufferSeconds: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly httpClient: AxiosInstance;
  private readonly redis: any;

  private inMemoryToken: string | null = null;
  private inMemoryExpiry: number = 0; // epoch ms
  private inFlightRefreshPromise: Promise<string> | null = null;

  constructor(options: AirtelClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.AIRTEL_API_KEY || "";
    this.apiSecret = options.apiSecret || process.env.AIRTEL_API_SECRET || "";
    this.baseUrl =
      options.baseUrl ||
      process.env.AIRTEL_DIRECT_BASE_URL ||
      process.env.AIRTEL_BASE_URL ||
      "https://openapi.airtel.africa";
    this.clientId = options.clientId || this.apiKey || "default";
    this.proactiveBufferSeconds = options.proactiveBufferSeconds ?? 60;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.clock = options.clock ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.httpClient =
      options.httpClient ||
      axios.create({
        baseURL: this.baseUrl,
        timeout: 10000,
        validateStatus: () => true,
      });
    this.redis = options.redis ?? redisClient;
  }

  getCacheKey(): string {
    return `airtel:oauth:token:${this.clientId}`;
  }

  /**
   * Returns true if the token is valid and not within the 60s proactive buffer.
   */
  isTokenValid(): boolean {
    if (!this.inMemoryToken) return false;
    const bufferMs = this.proactiveBufferSeconds * 1000;
    return this.clock() < this.inMemoryExpiry - bufferMs;
  }

  /**
   * Retrieves an active OAuth token:
   * 1. Returns valid in-memory token (if outside proactive buffer)
   * 2. Checks Redis cache (TTL already matches expires_in - 60s)
   * 3. Proactively refreshes token if expired or near expiration
   */
  async getAccessToken(): Promise<string> {
    // 1. Check in-memory token validity with proactive buffer
    if (this.isTokenValid()) {
      return this.inMemoryToken!;
    }

    // 2. Check Redis cache
    try {
      if (this.redis?.isOpen !== false && typeof this.redis?.get === "function") {
        const cached = await this.redis.get(this.getCacheKey());
        if (cached && typeof cached === "string") {
          this.inMemoryToken = cached;
          // Set in-memory expiry fallback (assuming at least proactiveBufferSeconds remain)
          this.inMemoryExpiry = this.clock() + this.proactiveBufferSeconds * 1000;
          return cached;
        }
      }
    } catch (err) {
      logger.warn({ error: err }, "AirtelTokenManager: Redis cache get failed, proceeding to refresh");
    }

    // 3. Proactive refresh with concurrent deduplication
    return this.refreshAccessToken();
  }

  /**
   * Deduplicates concurrent refresh requests using a single in-flight promise.
   */
  async refreshAccessToken(): Promise<string> {
    if (this.inFlightRefreshPromise) {
      return this.inFlightRefreshPromise;
    }

    this.inFlightRefreshPromise = (async () => {
      try {
        return await this.fetchTokenWithRetry();
      } finally {
        this.inFlightRefreshPromise = null;
      }
    })();

    return this.inFlightRefreshPromise;
  }

  /**
   * Invalidate cached token on Redis and in-memory (e.g. on 401 Unauthorized)
   */
  async invalidateToken(): Promise<void> {
    this.inMemoryToken = null;
    this.inMemoryExpiry = 0;
    try {
      if (this.redis?.isOpen !== false && typeof this.redis?.del === "function") {
        await this.redis.del(this.getCacheKey());
      }
    } catch (err) {
      logger.warn({ error: err }, "AirtelTokenManager: Failed to delete token from Redis");
    }
  }

  /**
   * Fetches token from Airtel OAuth endpoint with exponential backoff & randomized jitter.
   */
  private async fetchTokenWithRetry(): Promise<string> {
    let lastError: any = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const authHeader =
          "Basic " +
          Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64");

        const response: AxiosResponse = await this.httpClient.post(
          "/auth/oauth2/token",
          {},
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader,
            },
          },
        );

        const status = response.status ?? 200;

        if (status === 429 || status >= 500) {
          const delay = calculateJitteredBackoff(
            attempt,
            this.baseDelayMs,
            this.maxDelayMs,
          );
          logger.warn(
            { attempt, status, delayMs: delay },
            "AirtelTokenManager: Token request rate-limited/failed, backing off with jitter",
          );
          if (attempt < this.maxRetries) {
            await this.sleep(delay);
            continue;
          }
          throw new Error(
            `Airtel direct auth failed with status ${status} after ${attempt + 1} attempts`,
          );
        }

        if (status < 200 || status >= 300) {
          throw new Error(
            `Airtel direct auth failed with status ${status}`,
          );
        }

        const data = response.data as AirtelTokenResponse;
        if (!data?.access_token) {
          throw new Error("Airtel direct auth did not return access_token");
        }

        const token = data.access_token;
        const expiresInSeconds = Number(data.expires_in ?? 3600);

        // Update in-memory state
        this.inMemoryToken = token;
        this.inMemoryExpiry = this.clock() + expiresInSeconds * 1000;

        // Cache in Redis with proactive buffer TTL (expires_in - 60s)
        const redisTtlSeconds = Math.max(
          1,
          Math.floor(expiresInSeconds - this.proactiveBufferSeconds),
        );

        try {
          if (
            this.redis?.isOpen !== false &&
            typeof this.redis?.set === "function"
          ) {
            await this.redis.set(this.getCacheKey(), token, {
              EX: redisTtlSeconds,
            });
          }
        } catch (redisErr) {
          logger.warn(
            { error: redisErr },
            "AirtelTokenManager: Failed to cache token in Redis",
          );
        }

        logger.info(
          { expiresInSeconds, redisTtlSeconds },
          "AirtelTokenManager: Token successfully refreshed and cached with proactive buffer",
        );

        return token;
      } catch (err: any) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = calculateJitteredBackoff(
            attempt,
            this.baseDelayMs,
            this.maxDelayMs,
          );
          logger.warn(
            { attempt, error: err.message, delayMs: delay },
            "AirtelTokenManager: Exception in token refresh, retrying with backoff",
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error("Airtel OAuth token refresh failed after retries");
  }
}

/**
 * Resilient Airtel HTTP Client handling collection, disbursement,
 * proactive token refresh, and jittered retries on 429 rate limits.
 */
export class AirtelClient {
  public readonly tokenManager: AirtelTokenManager;
  private readonly httpClient: AxiosInstance;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly countryCode: string;
  private readonly currency: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AirtelClientOptions = {}) {
    this.tokenManager = new AirtelTokenManager(options);
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.countryCode = options.countryCode || process.env.AIRTEL_COUNTRY || "NG";
    this.currency = options.currency || process.env.AIRTEL_CURRENCY || "NGN";
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    const baseUrl =
      options.baseUrl ||
      process.env.AIRTEL_DIRECT_BASE_URL ||
      process.env.AIRTEL_BASE_URL ||
      "https://openapi.airtel.africa";

    this.httpClient =
      options.httpClient ||
      axios.create({
        baseURL: baseUrl,
        timeout: 10000,
        validateStatus: () => true,
      });
  }

  /**
   * Executes an authenticated request with automatic token injection,
   * 401 re-authentication, and 429 jittered exponential backoff retry.
   */
  async requestWithRetry<T = any>(
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    let lastResponse: AxiosResponse<T> | null = null;
    let lastError: any = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const token = await this.tokenManager.getAccessToken();

        const headers = {
          ...config.headers,
          Authorization: `Bearer ${token}`,
          "X-Country": this.countryCode,
          "X-Currency": this.currency,
          "Content-Type": config.headers?.["Content-Type"] || "application/json",
        };

        const response: AxiosResponse<T> = await this.httpClient.request({
          ...config,
          headers,
        });

        // 401 / 403: token expired mid-flight, invalidate and retry once immediately
        if (response.status === 401 || response.status === 403) {
          logger.warn(
            { status: response.status, attempt },
            "AirtelClient: Unauthorized response, invalidating token for refresh",
          );
          await this.tokenManager.invalidateToken();
          if (attempt < this.maxRetries) {
            continue;
          }
          return response;
        }

        // 429 Rate Limit or 5xx Server Error: exponential backoff with randomized jitter
        if (response.status === 429 || response.status >= 500) {
          lastResponse = response;
          if (attempt < this.maxRetries) {
            const delay = calculateJitteredBackoff(
              attempt,
              this.baseDelayMs,
              this.maxDelayMs,
            );
            logger.warn(
              { status: response.status, attempt, delayMs: delay },
              "AirtelClient: 429 / 5xx error encountered, backing off with jitter",
            );
            await this.sleep(delay);
            continue;
          }
          return response;
        }

        return response;
      } catch (err: any) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = calculateJitteredBackoff(
            attempt,
            this.baseDelayMs,
            this.maxDelayMs,
          );
          logger.warn(
            { attempt, error: err.message, delayMs: delay },
            "AirtelClient: Request exception, backing off with jitter",
          );
          await this.sleep(delay);
        }
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError ?? new Error("AirtelClient: Request failed after retries");
  }

  /**
   * Request collection (payment) from customer wallet
   */
  async requestPayment(
    phoneNumber: string,
    amount: string,
    reference: string,
  ): Promise<{ success: boolean; data?: any; error?: any }> {
    try {
      const response = await this.requestWithRetry({
        method: "POST",
        url: "/merchant/v1/payments/",
        data: {
          reference,
          subscriber: {
            country: this.countryCode,
            currency: this.currency,
            msisdn: phoneNumber,
          },
          transaction: {
            amount: parseFloat(amount),
            country: this.countryCode,
            currency: this.currency,
            id: reference,
          },
        },
      });

      const success = response.status >= 200 && response.status < 300;
      return { success, data: response.data, error: success ? undefined : response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Send disbursement (payout) to customer wallet
   */
  async sendPayout(
    phoneNumber: string,
    amount: string,
    reference: string,
  ): Promise<{ success: boolean; data?: any; error?: any }> {
    try {
      const response = await this.requestWithRetry({
        method: "POST",
        url: "/standard/v1/disbursements/",
        data: {
          reference,
          payee: {
            msisdn: phoneNumber,
          },
          transaction: {
            amount: parseFloat(amount),
            id: reference,
          },
        },
      });

      const success = response.status >= 200 && response.status < 300;
      return { success, data: response.data, error: success ? undefined : response.data };
    } catch (error) {
      return { success: false, error };
    }
  }
}

export default AirtelClient;
