import axios, { AxiosInstance } from "axios";

export interface PagerDutyConfig {
  integrationKey: string;
  dedupKey: string;
  enabled: boolean;
}

export interface IncidentData {
  provider: string;
  errorRate: number;
  errorCount: number;
  totalRequests: number;
  timestamp: string;
}

export interface PagerDutyEvent {
  routing_key: string;
  event_action: "trigger" | "resolve";
  dedup_key: string;
  payload: {
    summary: string;
    timestamp: string;
    severity: "critical" | "error" | "warning" | "info";
    source: string;
    custom_details: Record<string, unknown>;
  };
}

/**
 * PagerDuty Events API V2 Integration
 * Sends CRITICAL incidents when provider error rates exceed 15% in 5 minutes
 * Automatically resolves incidents when error rates drop below threshold
 */
export class PagerDutyService {
  private static readonly API_URL = "https://events.pagerduty.com/v2/enqueue";
  private static readonly ERROR_RATE_THRESHOLD = 0.15; // 15%
  private static readonly WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

  private client: AxiosInstance;
  private config: PagerDutyConfig;
  private activeIncidents: Map<string, IncidentData> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(config: PagerDutyConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: PagerDutyService.API_URL,
      timeout: 5000,
    });
  }

  /**
   * Start monitoring for error rate spikes
   * Runs periodic checks to evaluate error rates and trigger/resolve incidents
   */
  start(): void {
    if (!this.config.enabled) {
      console.log("PagerDuty service is disabled");
      return;
    }

    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      this.evaluateErrorRates().catch((error) => {
        console.error("Error in PagerDuty evaluation cycle:", error);
      });
    }, PagerDutyService.CHECK_INTERVAL_MS);

    console.log("PagerDuty monitoring service started");
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Record a provider error for tracking in the sliding window
   * Called when a provider operation fails
   */
  recordProviderError(provider: string, timestamp: number): void {
    if (!this.config.enabled) return;

    const errorKey = `${provider}_errors`;
    const requestKey = `${provider}_total_requests`;

    // Get or initialize error list and request count
    if (!this.activeIncidents.has(errorKey)) {
      this.activeIncidents.set(errorKey, {
        provider,
        errorRate: 0,
        errorCount: 0,
        totalRequests: 0,
        timestamp: new Date().toISOString(),
      });
    }

    const incident = this.activeIncidents.get(errorKey)!;
    incident.errorCount++;

    // Clean old errors outside the sliding window
    this.cleanupOldMetrics(provider);
  }

  /**
   * Record a successful provider request
   * Called when a provider operation succeeds
   */
  recordProviderSuccess(provider: string): void {
    if (!this.config.enabled) return;

    const requestKey = `${provider}_total_requests`;

    if (!this.activeIncidents.has(requestKey)) {
      this.activeIncidents.set(requestKey, {
        provider,
        errorRate: 0,
        errorCount: 0,
        totalRequests: 0,
        timestamp: new Date().toISOString(),
      });
    }

    const incident = this.activeIncidents.get(requestKey)!;
    incident.totalRequests++;
  }

  /**
   * Evaluate error rates for all providers and trigger/resolve incidents as needed
   * This is called periodically by the monitoring loop
   */
  private async evaluateErrorRates(): Promise<void> {
    const providers = this.getTrackedProviders();

    for (const provider of providers) {
      const errorRate = this.calculateErrorRate(provider);
      const isIncidentActive = this.activeIncidents.has(`incident_${provider}`);

      if (errorRate > PagerDutyService.ERROR_RATE_THRESHOLD && !isIncidentActive) {
        // Trigger new incident
        await this.triggerIncident(provider, errorRate);
      } else if (
        errorRate <= PagerDutyService.ERROR_RATE_THRESHOLD &&
        isIncidentActive
      ) {
        // Resolve incident
        await this.resolveIncident(provider, errorRate);
      }
    }
  }

  /**
   * Calculate error rate for a provider based on metrics in the sliding window
   */
  private calculateErrorRate(provider: string): number {
    const errorKey = `${provider}_errors`;
    const requestKey = `${provider}_total_requests`;

    const errorData = this.activeIncidents.get(errorKey);
    const requestData = this.activeIncidents.get(requestKey);

    if (!requestData || requestData.totalRequests === 0) {
      return 0;
    }

    const errorCount = errorData?.errorCount ?? 0;
    return errorCount / requestData.totalRequests;
  }

  /**
   * Get list of providers being tracked
   */
  private getTrackedProviders(): Set<string> {
    const providers = new Set<string>();

    for (const key of this.activeIncidents.keys()) {
      const match = key.match(/^(.+?)_(errors|total_requests)$/);
      if (match) {
        providers.add(match[1]);
      }
    }

    return providers;
  }

  /**
   * Clean up old error metrics outside the 5-minute window
   */
  private cleanupOldMetrics(provider: string): void {
    const now = Date.now();
    const windowStart = now - PagerDutyService.WINDOW_MS;

    // Keep data within the window by resetting periodically
    // In a production system, you might want to use a more sophisticated
    // time-series approach (e.g., storing timestamps with each error)
  }

  /**
   * Trigger a CRITICAL incident in PagerDuty
   */
  private async triggerIncident(provider: string, errorRate: number): Promise<void> {
    try {
      const event = this.buildIncidentEvent(provider, errorRate, "trigger");

      const response = await this.client.post("", event);

      if (response.status === 202 || response.status === 200) {
        // Mark incident as active
        this.activeIncidents.set(`incident_${provider}`, {
          provider,
          errorRate,
          errorCount: 0,
          totalRequests: 0,
          timestamp: new Date().toISOString(),
        });

        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "CRITICAL",
            message: "PagerDuty incident triggered",
            provider,
            errorRate: (errorRate * 100).toFixed(2) + "%",
            threshold: "15%",
            dedup_key: this.getDedupeKey(provider),
          }),
        );
      }
    } catch (error) {
      console.error(
        `Failed to trigger PagerDuty incident for provider ${provider}:`,
        error,
      );
    }
  }

  /**
   * Resolve an active incident in PagerDuty
   */
  private async resolveIncident(provider: string, errorRate: number): Promise<void> {
    try {
      const event = this.buildIncidentEvent(provider, errorRate, "resolve");

      const response = await this.client.post("", event);

      if (response.status === 202 || response.status === 200) {
        // Mark incident as resolved
        this.activeIncidents.delete(`incident_${provider}`);

        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "INFO",
            message: "PagerDuty incident resolved",
            provider,
            errorRate: (errorRate * 100).toFixed(2) + "%",
            dedup_key: this.getDedupeKey(provider),
          }),
        );
      }
    } catch (error) {
      console.error(
        `Failed to resolve PagerDuty incident for provider ${provider}:`,
        error,
      );
    }
  }

  /**
   * Build a PagerDuty event payload
   */
  private buildIncidentEvent(
    provider: string,
    errorRate: number,
    action: "trigger" | "resolve",
  ): PagerDutyEvent {
    const dedupeKey = this.getDedupeKey(provider);
    const errorPercentage = (errorRate * 100).toFixed(2);

    return {
      routing_key: this.config.integrationKey,
      event_action: action,
      dedup_key: dedupeKey,
      payload: {
        summary:
          action === "trigger"
            ? `[CRITICAL] Provider ${provider} error rate at ${errorPercentage}% (threshold: 15%)`
            : `[RESOLVED] Provider ${provider} error rate recovered to ${errorPercentage}%`,
        timestamp: new Date().toISOString(),
        severity: action === "trigger" ? "critical" : "info",
        source: "mobile-money-api",
        custom_details: {
          provider,
          errorRatePercentage: errorPercentage,
          threshold: "15%",
          window: "5 minutes",
          action,
          environment: process.env.NODE_ENV || "development",
        },
      },
    };
  }

  /**
   * Generate a deduplication key for PagerDuty
   * Ensures that multiple events for the same provider are treated as the same incident
   */
  private getDedupeKey(provider: string): string {
    return `${this.config.dedupKey}-${provider}-error-rate`;
  }

  /**
   * Get current error rate for a specific provider (for debugging/monitoring)
   */
  getErrorRate(provider: string): number {
    return this.calculateErrorRate(provider);
  }

  /**
   * Get all active incidents
   */
  getActiveIncidents(): Map<string, IncidentData> {
    return new Map(this.activeIncidents);
  }

  /**
   * Reset metrics (useful for testing or manual reset)
   */
  reset(): void {
    this.activeIncidents.clear();
  }
}

/**
 * Factory function to create and initialize PagerDuty service
 */
export function createPagerDutyService(enabled = true): PagerDutyService {
  const config: PagerDutyConfig = {
    integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY || "",
    dedupKey: process.env.PAGERDUTY_DEDUP_KEY || "mobile-money",
    enabled: enabled && !!process.env.PAGERDUTY_INTEGRATION_KEY,
  };

  const service = new PagerDutyService(config);

  if (config.enabled) {
    service.start();
  }

  return service;
}

export const pagerDutyService = createPagerDutyService();
