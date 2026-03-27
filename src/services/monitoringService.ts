import {
  register,
  providerResponseTimeSeconds,
  providerResponseTimeSummary,
} from "../utils/metrics";

export class MonitoringService {
  private static checkInterval: NodeJS.Timeout | null = null;
  private static readonly SLOW_RESPONSE_THRESHOLD_S = 10;
  private static readonly P95_THRESHOLD_S = 20;

  static start(intervalMs: number = 60000) {
    // Default 1 minute
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
            console.error(
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
    } catch (error) {
      console.error("Error in monitoring service checks", error);
    }
  }

  /**
   * Manual check for specific provider/operation.
   * Can be called after a batch of requests.
   */
  static async checkPerformance(provider: string, operation: string) {
    // Logic for immediate alerting if needed
  }
}
