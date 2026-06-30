import { providerRateLimitService } from "../providerRateLimitService";
import logger from "../../utils/logger";

export interface QueueThrottlerConfig {
  checkInterval: number; // How often to check and adjust concurrency (ms)
  providers: string[]; // Providers to monitor
}

export class DynamicQueueThrottler {
  private config: QueueThrottlerConfig;
  private workers: Map<string, unknown> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(config: QueueThrottlerConfig) {
    this.config = {
      checkInterval: config.checkInterval || 5000, // Default 5 seconds
      providers: config.providers || ["mtn", "airtel", "orange", "vodacom"],
    };
  }

  /**
   * Register a worker for dynamic throttling
   */
  registerWorker(provider: string, worker: unknown): void {
    this.workers.set(provider.toLowerCase(), worker);
    logger.info({ provider }, "Registered worker for dynamic throttling");
  }

  /**
   * Start the throttling loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("Dynamic queue throttler is already running");
      return;
    }

    this.isRunning = true;
    logger.info(
      {
        checkInterval: this.config.checkInterval,
        providers: this.config.providers,
      },
      "Starting dynamic queue throttler",
    );

    // Initial check
    this.adjustAllWorkers();

    // Set up interval for continuous adjustment
    this.intervalId = setInterval(() => {
      this.adjustAllWorkers();
    }, this.config.checkInterval);
  }

  /**
   * Stop the throttling loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info("Stopped dynamic queue throttler");
  }

  /**
   * Adjust concurrency for all registered workers
   */
  private async adjustAllWorkers(): Promise<void> {
    const promises = this.config.providers.map((provider) =>
      this.adjustWorkerConcurrency(provider),
    );

    await Promise.allSettled(promises);
  }

  /**
   * Adjust concurrency for a specific worker
   */
  private async adjustWorkerConcurrency(provider: string): Promise<void> {
    const worker = this.workers.get(provider.toLowerCase());
    if (!worker) {
      return; // Worker not registered
    }

    try {
      const recommendedConcurrency =
        await providerRateLimitService.getRecommendedConcurrency(provider);

      // Store recommended concurrency in Redis for the worker to pick up
      await providerRateLimitService.setConcurrency(
        provider,
        recommendedConcurrency,
      );

      logger.debug(
        {
          provider,
          recommendedConcurrency,
        },
        "Updated recommended concurrency in Redis",
      );
    } catch (error) {
      logger.error({ error, provider }, "Failed to adjust worker concurrency");
    }
  }

  /**
   * Get current throttling status for all providers
   */
  async getThrottlingStatus(): Promise<Record<string, unknown>> {
    const status: Record<string, unknown> = {};

    for (const provider of this.config.providers) {
      const rateLimit =
        await providerRateLimitService.getRateLimitState(provider);
      const concurrency =
        await providerRateLimitService.getCurrentConcurrency(provider);

      status[provider] = {
        isRateLimited: rateLimit
          ? providerRateLimitService.isRateLimited(rateLimit)
          : false,
        rateLimit: rateLimit
          ? {
              remaining: rateLimit.remaining,
              limit: rateLimit.limit,
              resetAt: new Date(rateLimit.resetAt).toISOString(),
              retryAfter: rateLimit.retryAfter,
            }
          : null,
        currentConcurrency: concurrency,
        maxConcurrency: 20,
        minConcurrency: 1,
      };
    }

    return status;
  }

  /**
   * Reset rate limiting for a specific provider
   */
  async resetProvider(provider: string): Promise<void> {
    await providerRateLimitService.resetRateLimit(provider);
    logger.info({ provider }, "Reset rate limiting for provider");
  }

  /**
   * Reset rate limiting for all providers
   */
  async resetAll(): Promise<void> {
    for (const provider of this.config.providers) {
      await this.resetProvider(provider);
    }
    logger.info("Reset rate limiting for all providers");
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<QueueThrottlerConfig>): void {
    if (config.checkInterval) {
      this.config.checkInterval = config.checkInterval;
    }
    if (config.providers) {
      this.config.providers = config.providers;
    }

    // Restart if running to apply new config
    if (this.isRunning) {
      this.stop();
      this.start();
    }

    logger.info({ config: this.config }, "Updated throttler configuration");
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stop();
    this.workers.clear();
    logger.info("Destroyed dynamic queue throttler");
  }
}

// Singleton instance
export const dynamicQueueThrottler = new DynamicQueueThrottler({
  checkInterval: 5000,
  providers: ["mtn", "airtel", "orange", "vodacom"],
});
