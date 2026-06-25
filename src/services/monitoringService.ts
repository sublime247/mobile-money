import logger from "../utils/logger";
import {
  register,
  providerResponseTimeSeconds,
  providerResponseTimeSummary,
  transactionErrorsTotal,
  transactionTotal,
} from "../utils/metrics";
import type { PagerDutyService } from "./pagerDutyService";

interface ProviderMetrics {
  provider: string;
  errorCount: number;
  totalCount: number;
  errorRate: number;
  lastUpdated: Date;
}

export class MonitoringService {
  private static checkInterval: NodeJS.Timeout | null = null;
  private static readonly SLOW_RESPONSE_THRESHOLD_S = 10;
  private static readonly P95_THRESHOLD_S = 20;
  private static readonly ERROR_RATE_THRESHOLD = 0.15; // 15%
  private static readonly WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  private static pagerDutyService: PagerDutyService | null = null;
  private static providerMetricsWindow: Map<string, ProviderMetrics> = new Map();
  private static metricsHistory: Map<
    string,
    Array<{ timestamp: number; errorCount: number; totalCount: number }>
  > = new Map();

  /**
   * Initialize the monitoring service with PagerDuty integration
   */
  static initialize(pagerDutyService?: PagerDutyService) {
    this.pagerDutyService = pagerDutyService || null;
  }

  static start(intervalMs: number = 30000) {
    // Default 30 seconds for more frequent error rate checks
    if (this.checkInterval) return;

    this.checkInterval = setInterval(async () => {
      await this.runChecks();
    }, intervalMs);

    console.log(`Monitoring service started with interval ${intervalMs}ms`);
  }

  static stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private static async runChecks() {
    try {
      const metrics = await register.getMetricsAsJSON();

      // 1. Check performance metrics (P95)
      this.checkPerformanceMetrics(metrics);

      // 2. Check provider error rates (new PagerDuty integration)
      this.checkProviderErrorRates(metrics);
    } catch (error) {
      logger.error("Error in monitoring service checks", error);
    }
  }

  /**
   * Check performance metrics and alert on degradation
   */
  private static checkPerformanceMetrics(
    metrics: Array<{ name: string; values: Array<{ labels: Record<string, unknown>; value: number }> }>,
  ) {
    // 1. Check for slow average responses in Histogram
    const histogram = metrics.find(
      (m) => m.name === "provider_response_time_seconds",
    );
    if (histogram && Array.isArray(histogram.values)) {
      // We look at the sum / count for each label set
      // But prom-client JSON output is a bit complex.
      // For simplicity, we can also just use the Summary quantiles.
    }

    // 2. Check P95 from Summary
    const summary = metrics.find(
      (m) => m.name === "provider_response_time_summary",
    );
    if (summary && Array.isArray(summary.values)) {
      for (const val of summary.values) {
        if (
          val.labels.quantile === 0.95 &&
          val.value > this.P95_THRESHOLD_S
        ) {
          logger.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "CRITICAL",
              message: "Degraded performance: P95 response time too high",
              provider: val.labels.provider,
              operation: val.labels.operation,
              p95_seconds: val.value,
              threshold_seconds: this.P95_THRESHOLD_S,
            }),
          );
        }
      }
    }
  }

  /**
   * Check provider error rates within the 5-minute sliding window
   * Triggers PagerDuty incidents when error rate exceeds 15%
   */
  private static checkProviderErrorRates(
    metrics: Array<{ name: string; values: Array<{ labels: Record<string, unknown>; value: number }> }>,
  ) {
    if (!this.pagerDutyService) return;

    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;

    // Get transaction metrics
    const errorMetric = metrics.find(
      (m) => m.name === "transaction_errors_total",
    );
    const totalMetric = metrics.find((m) => m.name === "transaction_total");

    const providerErrors = new Map<string, number>();
    const providerTotals = new Map<string, number>();

    // Aggregate errors by provider
    if (errorMetric && Array.isArray(errorMetric.values)) {
      for (const val of errorMetric.values) {
        const provider = val.labels.provider as string;
        const currentCount = providerErrors.get(provider) || 0;
        providerErrors.set(provider, currentCount + val.value);
      }
    }

    // Aggregate totals by provider
    if (totalMetric && Array.isArray(totalMetric.values)) {
      for (const val of totalMetric.values) {
        const provider = val.labels.provider as string;
        const currentCount = providerTotals.get(provider) || 0;
        providerTotals.set(provider, currentCount + val.value);
      }
    }

    // Calculate error rates and trigger/resolve incidents
    const providers = new Set([...providerErrors.keys(), ...providerTotals.keys()]);

    for (const provider of providers) {
      const errorCount = providerErrors.get(provider) || 0;
      const totalCount = providerTotals.get(provider) || 0;

      // Record metrics in history for sliding window calculation
      this.recordMetricHistory(provider, errorCount, totalCount);

      // Calculate error rate within the sliding window
      const windowMetrics = this.getMetricsInWindow(provider, windowStart);
      const errorRate = this.calculateErrorRate(windowMetrics);

      // Update current metrics
      const metrics: ProviderMetrics = {
        provider,
        errorCount: windowMetrics.totalErrors,
        totalCount: windowMetrics.totalCount,
        errorRate,
        lastUpdated: new Date(),
      };

      this.providerMetricsWindow.set(provider, metrics);

      // Decision logic for PagerDuty
      if (errorRate > this.ERROR_RATE_THRESHOLD) {
        this.pagerDutyService.recordProviderError(
          provider,
          now,
        );

        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "WARNING",
            message: "Provider error rate exceeded threshold",
            provider,
            errorRate: (errorRate * 100).toFixed(2) + "%",
            threshold: "15%",
            window: "5 minutes",
            errorCount: windowMetrics.totalErrors,
            totalCount: windowMetrics.totalCount,
          }),
        );
      } else if (errorRate <= this.ERROR_RATE_THRESHOLD) {
        this.pagerDutyService.recordProviderSuccess(provider);
      }
    }
  }

  /**
   * Record metric data point in history for sliding window calculation
   */
  private static recordMetricHistory(
    provider: string,
    errorCount: number,
    totalCount: number,
  ) {
    if (!this.metricsHistory.has(provider)) {
      this.metricsHistory.set(provider, []);
    }

    const history = this.metricsHistory.get(provider)!;
    history.push({
      timestamp: Date.now(),
      errorCount,
      totalCount,
    });

    // Keep only the last 5 minutes of data
    const fiveMinutesAgo = Date.now() - this.WINDOW_MS;
    const filtered = history.filter((h) => h.timestamp >= fiveMinutesAgo);
    this.metricsHistory.set(provider, filtered);
  }

  /**
   * Get aggregated metrics for a provider within the sliding window
   */
  private static getMetricsInWindow(provider: string, windowStart: number) {
    const history = this.metricsHistory.get(provider) || [];

    let totalErrors = 0;
    let totalCount = 0;

    for (const entry of history) {
      if (entry.timestamp >= windowStart) {
        totalErrors += entry.errorCount;
        totalCount += entry.totalCount;
      }
    }

    return {
      totalErrors,
      totalCount,
    };
  }

  /**
   * Calculate error rate from window metrics
   */
  private static calculateErrorRate(windowMetrics: {
    totalErrors: number;
    totalCount: number;
  }): number {
    if (windowMetrics.totalCount === 0) {
      return 0;
    }
    return windowMetrics.totalErrors / windowMetrics.totalCount;
  }

  /**
   * Manual check for specific provider/operation.
   * Can be called after a batch of requests.
   */
  static async checkPerformance(provider: string, operation: string) {
    // Logic for immediate alerting if needed
  }

  /**
   * Get current metrics for all providers
   */
  static getProviderMetrics(): ProviderMetrics[] {
    return Array.from(this.providerMetricsWindow.values());
  }

  /**
   * Get metrics for a specific provider
   */
  static getProviderMetricsFor(provider: string): ProviderMetrics | undefined {
    return this.providerMetricsWindow.get(provider);
  }
}
