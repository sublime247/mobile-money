import { redisClient } from "../config/redis";
import logger from "../utils/logger";

export interface RateLimitState {
  provider: string;
  remaining: number;
  limit: number;
  resetAt: number; // Unix timestamp in milliseconds
  retryAfter?: number; // Seconds until retry is allowed
  lastUpdated: Date;
}

export interface ProviderRateLimitConfig {
  provider: string;
  maxConcurrentJobs: number;
  minConcurrentJobs: number;
  throttleStep: number; // How much to reduce concurrency on rate limit hit
  recoveryStep: number; // How much to increase concurrency on recovery
  recoveryInterval: number; // Milliseconds before attempting recovery
}

export class ProviderRateLimitService {
  private readonly RATE_LIMIT_PREFIX = "rate_limit:";
  private readonly DEFAULT_TTL = 3600; // 1 hour in seconds

  private readonly defaultConfigs: Map<string, ProviderRateLimitConfig> =
    new Map([
      [
        "mtn",
        {
          provider: "mtn",
          maxConcurrentJobs: 20,
          minConcurrentJobs: 2,
          throttleStep: 3,
          recoveryStep: 1,
          recoveryInterval: 60000, // 1 minute
        },
      ],
      [
        "airtel",
        {
          provider: "airtel",
          maxConcurrentJobs: 15,
          minConcurrentJobs: 2,
          throttleStep: 2,
          recoveryStep: 1,
          recoveryInterval: 60000,
        },
      ],
      [
        "orange",
        {
          provider: "orange",
          maxConcurrentJobs: 18,
          minConcurrentJobs: 2,
          throttleStep: 3,
          recoveryStep: 1,
          recoveryInterval: 60000,
        },
      ],
      [
        "vodacom",
        {
          provider: "vodacom",
          maxConcurrentJobs: 15,
          minConcurrentJobs: 2,
          throttleStep: 2,
          recoveryStep: 1,
          recoveryInterval: 60000,
        },
      ],
    ]);

  /**
   * Extract rate limit headers from provider response
   */
  extractRateLimitHeaders(
    provider: string,
    headers: Record<string, string | string[] | undefined>,
  ): Partial<RateLimitState> {
    const rateLimit: Partial<RateLimitState> = {
      provider,
      lastUpdated: new Date(),
    };

    // Common rate limit header patterns
    const remaining = this.extractHeaderValue(headers, [
      "X-RateLimit-Remaining",
      "X-Rate-Limit-Remaining",
      "X-Remaining",
      "ratelimit-remaining",
    ]);

    const limit = this.extractHeaderValue(headers, [
      "X-RateLimit-Limit",
      "X-Rate-Limit-Limit",
      "X-Limit",
      "ratelimit-limit",
    ]);

    const reset = this.extractHeaderValue(headers, [
      "X-RateLimit-Reset",
      "X-Rate-Limit-Reset",
      "X-Reset",
      "ratelimit-reset",
    ]);

    const retryAfter = this.extractHeaderValue(headers, [
      "Retry-After",
      "retry-after",
    ]);

    if (remaining !== undefined) {
      rateLimit.remaining = parseInt(remaining, 10);
    }

    if (limit !== undefined) {
      rateLimit.limit = parseInt(limit, 10);
    }

    if (reset !== undefined) {
      // Handle both Unix timestamp and seconds from now
      const resetValue = parseInt(reset, 10);
      if (resetValue > 1000000000000) {
        // Already a Unix timestamp in milliseconds
        rateLimit.resetAt = resetValue;
      } else {
        // Seconds from now
        rateLimit.resetAt = Date.now() + resetValue * 1000;
      }
    }

    if (retryAfter !== undefined) {
      rateLimit.retryAfter = parseInt(retryAfter, 10);
    }

    return rateLimit;
  }

  /**
   * Update rate limit state in Redis
   */
  async updateRateLimitState(rateLimit: RateLimitState): Promise<void> {
    const key = this.getRateLimitKey(rateLimit.provider);
    const ttl = this.calculateTTL(rateLimit.resetAt);

    try {
      await redisClient.setEx(key, ttl, JSON.stringify(rateLimit));

      logger.debug(
        {
          provider: rateLimit.provider,
          remaining: rateLimit.remaining,
          limit: rateLimit.limit,
          resetAt: new Date(rateLimit.resetAt).toISOString(),
        },
        "Updated provider rate limit state",
      );
    } catch (error) {
      logger.error(
        { error, provider: rateLimit.provider },
        "Failed to update rate limit state in Redis",
      );
    }
  }

  /**
   * Get current rate limit state for a provider
   */
  async getRateLimitState(provider: string): Promise<RateLimitState | null> {
    const key = this.getRateLimitKey(provider);

    try {
      const data = await redisClient.get(key);
      if (!data) {
        return null;
      }

      return JSON.parse(data.toString()) as RateLimitState;
    } catch (error) {
      logger.error(
        { error, provider },
        "Failed to get rate limit state from Redis",
      );
      return null;
    }
  }

  /**
   * Calculate recommended concurrency for a provider based on rate limit state
   */
  async getRecommendedConcurrency(provider: string): Promise<number> {
    const rateLimit = await this.getRateLimitState(provider);
    const config = this.getProviderConfig(provider);

    if (!rateLimit) {
      // No rate limit data, use max concurrency
      return config.maxConcurrentJobs;
    }

    // Check if we're rate limited
    if (this.isRateLimited(rateLimit)) {
      // Calculate throttled concurrency
      const currentConcurrency = await this.getCurrentConcurrency(provider);
      const throttledConcurrency = Math.max(
        config.minConcurrentJobs,
        currentConcurrency - config.throttleStep,
      );

      logger.warn(
        {
          provider,
          remaining: rateLimit.remaining,
          limit: rateLimit.limit,
          recommendedConcurrency: throttledConcurrency,
        },
        "Provider rate limited - throttling concurrency",
      );

      return throttledConcurrency;
    }

    // Check if we should recover concurrency
    const currentConcurrency = await this.getCurrentConcurrency(provider);
    if (currentConcurrency < config.maxConcurrentJobs) {
      const lastUpdate = new Date(rateLimit.lastUpdated).getTime();
      const timeSinceUpdate = Date.now() - lastUpdate;

      if (timeSinceUpdate >= config.recoveryInterval) {
        const recoveredConcurrency = Math.min(
          config.maxConcurrentJobs,
          currentConcurrency + config.recoveryStep,
        );

        logger.info(
          {
            provider,
            currentConcurrency,
            newConcurrency: recoveredConcurrency,
          },
          "Recovering provider concurrency",
        );

        return recoveredConcurrency;
      }
    }

    return currentConcurrency;
  }

  /**
   * Check if provider is currently rate limited
   */
  isRateLimited(rateLimit: RateLimitState): boolean {
    const now = Date.now();

    // Check if we're past the reset time
    if (now >= rateLimit.resetAt) {
      return false;
    }

    // Check if remaining requests is critically low (less than 10% of limit)
    const usagePercentage =
      (rateLimit.limit - rateLimit.remaining) / rateLimit.limit;
    return usagePercentage >= 0.9 || rateLimit.remaining === 0;
  }

  /**
   * Get current concurrency setting for a provider
   */
  public async getCurrentConcurrency(provider: string): Promise<number> {
    const key = `concurrency:${provider}`;
    const concurrency = await redisClient.get(key);

    if (!concurrency) {
      const config = this.getProviderConfig(provider);
      await redisClient.set(key, config.maxConcurrentJobs.toString());
      return config.maxConcurrentJobs;
    }

    return parseInt(concurrency.toString(), 10);
  }

  /**
   * Set concurrency for a provider
   */
  async setConcurrency(provider: string, concurrency: number): Promise<void> {
    const key = `concurrency:${provider}`;
    const config = this.getProviderConfig(provider);

    // Clamp to valid range
    const clampedConcurrency = Math.max(
      config.minConcurrentJobs,
      Math.min(config.maxConcurrentJobs, concurrency),
    );

    await redisClient.set(key, clampedConcurrency.toString());

    logger.info(
      { provider, concurrency: clampedConcurrency },
      "Updated provider concurrency",
    );
  }

  /**
   * Handle 429 Too Many Requests response
   */
  async handleRateLimitError(
    provider: string,
    retryAfter?: number,
  ): Promise<void> {
    const config = this.getProviderConfig(provider);
    const currentConcurrency = await this.getCurrentConcurrency(provider);

    // Aggressively throttle on 429
    const newConcurrency = Math.max(
      config.minConcurrentJobs,
      Math.floor(currentConcurrency / 2),
    );

    await this.setConcurrency(provider, newConcurrency);

    // Update rate limit state
    const rateLimit: RateLimitState = {
      provider,
      remaining: 0,
      limit: config.maxConcurrentJobs,
      resetAt: Date.now() + (retryAfter || 60) * 1000,
      retryAfter: retryAfter || 60,
      lastUpdated: new Date(),
    };

    await this.updateRateLimitState(rateLimit);

    logger.error(
      {
        provider,
        retryAfter: retryAfter || 60,
        newConcurrency,
      },
      "Provider returned 429 - aggressively throttling",
    );
  }

  /**
   * Reset rate limit state for a provider (manual override)
   */
  async resetRateLimit(provider: string): Promise<void> {
    const key = this.getRateLimitKey(provider);
    await redisClient.del(key);

    const config = this.getProviderConfig(provider);
    await this.setConcurrency(provider, config.maxConcurrentJobs);

    logger.info({ provider }, "Reset provider rate limit state");
  }

  /**
   * Get provider configuration
   */
  private getProviderConfig(provider: string): ProviderRateLimitConfig {
    const normalizedProvider = provider.toLowerCase();
    const config = this.defaultConfigs.get(normalizedProvider);

    if (config) {
      return config;
    }

    // Return default config for unknown providers
    return {
      provider: normalizedProvider,
      maxConcurrentJobs: 10,
      minConcurrentJobs: 1,
      throttleStep: 2,
      recoveryStep: 1,
      recoveryInterval: 60000,
    };
  }

  /**
   * Extract header value from various header formats
   */
  private extractHeaderValue(
    headers: Record<string, string | string[] | undefined>,
    possibleKeys: string[],
  ): string | undefined {
    for (const key of possibleKeys) {
      const value = headers[key.toLowerCase()] || headers[key];
      if (value !== undefined) {
        if (Array.isArray(value)) {
          return value[0];
        }
        return value;
      }
    }
    return undefined;
  }

  /**
   * Generate Redis key for rate limit state
   */
  private getRateLimitKey(provider: string): string {
    return `${this.RATE_LIMIT_PREFIX}${provider.toLowerCase()}`;
  }

  /**
   * Calculate TTL based on reset timestamp
   */
  private calculateTTL(resetAt: number): number {
    const now = Date.now();
    const ttlSeconds = Math.ceil((resetAt - now) / 1000);
    return Math.max(ttlSeconds, 60); // Minimum 60 seconds TTL
  }
}

export const providerRateLimitService = new ProviderRateLimitService();
