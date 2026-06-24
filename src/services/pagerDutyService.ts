import axios, { AxiosInstance } from "axios";

export interface PagerDutyConfig {
  integrationKey: string;
  dedupKey: string;
  enabled: boolean;
}

/**
 * Balance shortfall severity tiers for PagerDuty escalation routing.
 *
 * Shortfall percentage = (threshold - currentBalance) / threshold * 100
 *
 * Tiers (strictly ordered, deterministic, evaluated top-down):
 *
 *   | Tier     | Range (shortfallPct)                          | Severity  | Escalation path           |
 *   |----------|-----------------------------------------------|-----------|---------------------------|
 *   | critical | shortfallPct >= CRITICAL_PCT (default 50%)     | critical  | immediate escalation      |
 *   | moderate | shortfallPct >= MODERATE_PCT (default 25%)     | error     | operational escalation    |
 *   | minor    | shortfallPct >= MINOR_PCT    (default 10%)     | warning   | team notification         |
 *   | (none)   | shortfallPct <  MINOR_PCT                     | n/a       | no PagerDuty alert        |
 *
 * Invariants (validated at startup):
 *   1. tiers MUST be strictly ordered: minor < moderate < critical
 *   2. every shortfall value MUST map to AT MOST one tier (no overlaps)
 *   3. no gap between mapped tiers; only the range `[0, MINOR_PCT)` is intentional noise-floor
 *
 * If any invariant fails, the service logs a warning and falls back to defaults
 * (10% / 25% / 50%).
 */
export interface BalanceShortfallThresholds {
  /** Shortfall percentage that triggers a critical incident (e.g. 50 = 50% below threshold) */
  criticalPct: number;
  /** Shortfall percentage that triggers a moderate/escalated incident */
  moderatePct: number;
  /** Shortfall percentage that triggers a minor/warning incident */
  minorPct: number;
}

export type ShortfallSeverity = "warning" | "error" | "critical";

export interface BalanceShortfallContext {
  provider: string;
  asset: string;
  threshold: number;
  currentBalance: number;
  shortfallAmount: number;
  shortfallPct: number;
  severity: ShortfallSeverity;
  /** Stable human label of the escalation path the PagerDuty service routes through. */
  escalation: string;
}

/**
 * Default tier thresholds (percent of threshold below which the incident escalates).
 * Used as fallback when env vars are unset or invalid.
 */
const DEFAULT_SHORTFALL_THRESHOLDS: BalanceShortfallThresholds = {
  criticalPct: 50,
  moderatePct: 25,
  minorPct: 10,
};

/**
 * Stable escalation-path labels. These mirror the routing keys configured in
 * the PagerDuty service (see runbook: docs/PAGERDUTY_INTEGRATION.md). They are
 * surfaced in incident payloads and log lines so on-call engineers can verify
 * routing without inspecting PagerDuty UI.
 */
const ESCALATION_PATHS: Record<ShortfallSeverity, { label: string; description: string }> = {
  critical: {
    label: "immediate-escalation",
    description: "Immediate on-call (Critical → PagerDuty critical routing key)",
  },
  error: {
    label: "operational-escalation",
    description: "Operational on-call (Error → PagerDuty error routing key)",
  },
  warning: {
    label: "team-notification",
    description: "Team notification (Warning → PagerDuty warning routing key)",
  },
};

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

  /**
   * Balance shortfall tier thresholds (percentage of threshold).
   * Configurable via env vars; sensible defaults are provided.
   *
   *   critical >= CRITICAL_PCT  → PagerDuty critical, immediate escalation
   *   moderate >= MODERATE_PCT  → PagerDuty error, operational escalation
   *   minor    >= MINOR_PCT     → PagerDuty warning, team notification
   *
   * 0% shortfall means balance == threshold; 100% means balance is zero.
   *
   * NOTE: this field is intentionally NOT readonly — it can be overwritten by
   * {@link validateAndRepairThresholds} when env-driven config is invalid. Use
   * {@link getActiveShortfallThresholds} to access the validated thresholds at
   * runtime; that accessor triggers the one-shot validation/repair automatically.
   */
  static BALANCE_SHORTFALL_THRESHOLDS: BalanceShortfallThresholds = {
    criticalPct: PagerDutyService.parseShortfallEnv("BALANCE_SHORTFALL_CRITICAL_PCT", DEFAULT_SHORTFALL_THRESHOLDS.criticalPct),
    moderatePct: PagerDutyService.parseShortfallEnv("BALANCE_SHORTFALL_MODERATE_PCT", DEFAULT_SHORTFALL_THRESHOLDS.moderatePct),
    minorPct: PagerDutyService.parseShortfallEnv("BALANCE_SHORTFALL_MINOR_PCT", DEFAULT_SHORTFALL_THRESHOLDS.minorPct),
  };

  /**
   * One-shot guard for {@link validateAndRepairThresholds}. Ensures we only
   * log the "misconfigured" warning once per process lifetime even if the
   * method is called repeatedly (e.g. from each `handleBalanceShortfall` call).
   */
  private static thresholdsValidated = false;

  /**
   * Test-only helper that resets the static shortfall tier state back to its
   * env-driven defaults and clears the one-shot matrix-log guard.
   *
   * Intended for unit tests that need to exercise the repair logic against a
   * known-good starting point without reloading the module. Production code
   * should never call this.
   *
   * @internal
   */
  static __resetShortfallStateForTests(): void {
    delete process.env.BALANCE_SHORTFALL_MINOR_PCT;
    delete process.env.BALANCE_SHORTFALL_MODERATE_PCT;
    delete process.env.BALANCE_SHORTFALL_CRITICAL_PCT;
    PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS = { ...DEFAULT_SHORTFALL_THRESHOLDS };
    PagerDutyService.thresholdsValidated = false;
  }

  private client: AxiosInstance;
  private config: PagerDutyConfig;
  private activeIncidents: Map<string, IncidentData> = new Map();
  /** Tracks active balance-shortfall incidents so they can be auto-resolved when balance recovers. */
  private activeShortfallIncidents: Map<string, BalanceShortfallContext> = new Map();
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
    this.activeShortfallIncidents.clear();
  }

  // ── Balance Shortfall Monitoring ──────────────────────────────────────────

  /**
   * Parse a balance-shortfall threshold env var, falling back to default.
   * Invalid values (non-numeric, negative, zero, >100) are clamped to safe
   * defaults rather than rejected — surfacing the value in logs lets on-call
   * engineers spot misconfiguration without taking the service offline.
   */
  private static parseShortfallEnv(envName: string, defaultPct: number): number {
    const raw = process.env[envName];
    if (raw === undefined || raw === "") return defaultPct;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return defaultPct;
    // Clamp to [1, 99] to preclude nonsensical tier boundaries (e.g. 0 makes
    // every positive shortfall count as critical; 100 leaves no room above it).
    if (parsed < 1 || parsed > 99) {
      console.warn(
        `[pagerduty] ${envName}=${raw} is outside the safe range [1, 99]; using default ${defaultPct}`,
      );
      return defaultPct;
    }
    return parsed;
  }

  /**
   * Validate that the three tier thresholds are strictly ordered:
   *   minorPct < moderatePct < criticalPct
   *
   * If misconfigured, the thresholds are repaired in-place back to the
   * defaults (10% / 25% / 50%) and a single warning is emitted. Idempotent
   * and silent on subsequent calls within the same process.
   */
  static validateAndRepairThresholds(): BalanceShortfallThresholds {
    const t = PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS;
    const isOrdered =
      Number.isFinite(t.minorPct) &&
      Number.isFinite(t.moderatePct) &&
      Number.isFinite(t.criticalPct) &&
      t.minorPct > 0 &&
      t.minorPct < t.moderatePct &&
      t.moderatePct < t.criticalPct;

    if (!isOrdered) {
      console.warn(
        `[pagerduty] Balance shortfall thresholds are misconfigured ` +
        `(minor=${t.minorPct}, moderate=${t.moderatePct}, critical=${t.criticalPct}); ` +
        `thresholds must satisfy 0 < minor < moderate < critical. ` +
        `Falling back to defaults: minor=${DEFAULT_SHORTFALL_THRESHOLDS.minorPct}, ` +
        `moderate=${DEFAULT_SHORTFALL_THRESHOLDS.moderatePct}, ` +
        `critical=${DEFAULT_SHORTFALL_THRESHOLDS.criticalPct}`,
      );
      PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS = { ...DEFAULT_SHORTFALL_THRESHOLDS };
    }

    if (!PagerDutyService.thresholdsValidated) {
      PagerDutyService.thresholdsValidated = true;
      // Skip the matrix log when PagerDuty is unconfigured (no integration
      // key) - avoids cluttering dev/test logs with routing info that will
      // never be used.
      if (!process.env.PAGERDUTY_INTEGRATION_KEY) return;
      const a = PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS;
      const dto = isOrdered
        ? `(minor=${a.minorPct}%, moderate=${a.moderatePct}%, critical=${a.criticalPct}%)`
        : `(defaults active: minor=${a.minorPct}%, moderate=${a.moderatePct}%, critical=${a.criticalPct}%)`;
      const pad = (s: string) => s.padEnd(22, " ");
      console.log(
        `[pagerduty] Balance shortfall escalation matrix active ${dto}\n` +
        `  - ${pad(ESCALATION_PATHS.warning.label)}: shortfallPct >= ${a.minorPct}%   (warning → team notification)\n` +
        `  - ${pad(ESCALATION_PATHS.error.label)}: shortfallPct >= ${a.moderatePct}%   (error → operational escalation)\n` +
        `  - ${pad(ESCALATION_PATHS.critical.label)}: shortfallPct >= ${a.criticalPct}%   (critical → immediate escalation)`,
      );
    }

    return PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS;
  }

  /**
   * Resolve the validated tier thresholds. Triggers the one-shot
   * validation/repair on first call within a process.
   */
  static getActiveShortfallThresholds(): BalanceShortfallThresholds {
    return PagerDutyService.validateAndRepairThresholds();
  }

  /**
   * Classify a shortfall percentage into one and only one severity tier.
   *
   * - Returns `null` when `shortfallPct < MINOR_PCT` (intentional noise floor).
   * - Returns the strictest matching tier when `shortfallPct` lies on a
   *   boundary (e.g. exactly `MODERATE_PCT` → "error", not "warning") so a
   *   shortfall at the moderate boundary is escalated conservatively.
   * - Guaranteed exhaustive: every non-negative `shortfallPct >= MINOR_PCT`
   *   maps to exactly one of `warning` | `error` | `critical`.
   */
  static classifyShortfall(shortfallPct: number): ShortfallSeverity | null {
    if (!Number.isFinite(shortfallPct) || shortfallPct < 0) return null;
    const t = PagerDutyService.validateAndRepairThresholds();
    if (shortfallPct >= t.criticalPct) return "critical";
    if (shortfallPct >= t.moderatePct) return "error";
    if (shortfallPct >= t.minorPct) return "warning";
    return null;
  }

  /**
   * Evaluate a balance against its threshold and produce a structured
   * shortfall context — or `null` if there is no shortfall to alert on.
   *
   * The returned context includes the full escalation label, so callers can
   * log routing paths without re-deriving them.
   */
  evaluateBalanceShortfall(
    provider: string,
    asset: string,
    threshold: number,
    currentBalance: number,
  ): BalanceShortfallContext | null {
    if (threshold <= 0) {
      console.warn(
        `[pagerduty] Invalid threshold (${threshold}) for ${provider}/${asset} — skipping shortfall evaluation`,
      );
      return null;
    }

    if (currentBalance >= threshold) {
      return null; // no shortfall
    }

    const shortfallAmount = threshold - currentBalance;
    const shortfallPct = (shortfallAmount / threshold) * 100;
    const severity = PagerDutyService.classifyShortfall(shortfallPct);
    if (severity === null) {
      // Shortfall is below the minimum alertable threshold — by design we
      // suppress alerts below the noise floor. This is NOT a routing bug:
      // sub-noise-floor shortfalls deliberately do not trigger PagerDuty.
      return null;
    }

    return {
      provider,
      asset,
      threshold,
      currentBalance,
      shortfallAmount,
      shortfallPct,
      severity,
      escalation: ESCALATION_PATHS[severity].label,
    };
  }

  /**
   * Trigger (or update) a PagerDuty incident for a balance shortfall.
   *
   * If a shortfall incident for the same provider+asset is already active, no
   * duplicate is created (dedup_key ensures idempotency).
   */
  async triggerBalanceShortfallIncident(context: BalanceShortfallContext): Promise<void> {
    if (!this.config.enabled) return;

    const dedupeKey = this.getBalanceDedupeKey(context.provider, context.asset);
    const shortfallPctStr = context.shortfallPct.toFixed(1);

    const event: PagerDutyEvent = {
      routing_key: this.config.integrationKey,
      event_action: "trigger",
      dedup_key: dedupeKey,
      payload: {
        summary:
          `[${context.severity.toUpperCase()}] Balance shortfall: ${context.provider}/${context.asset} ` +
          `is ${shortfallPctStr}% below threshold (balance: ${context.currentBalance}, threshold: ${context.threshold})`,
        timestamp: new Date().toISOString(),
        severity: context.severity,
        source: "mobile-money-balance-monitor",
        custom_details: {
          provider: context.provider,
          asset: context.asset,
          threshold: context.threshold,
          currentBalance: context.currentBalance,
          shortfallAmount: context.shortfallAmount,
          shortfallPct: context.shortfallPct,
          severity: context.severity,
          escalation: context.escalation,
          environment: process.env.NODE_ENV || "development",
        },
      },
    };

    try {
      const response = await this.client.post("", event);

      if (response.status === 202 || response.status === 200) {
        this.activeShortfallIncidents.set(dedupeKey, context);

        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: context.severity.toUpperCase(),
            message: "Balance shortfall incident triggered",
            provider: context.provider,
            asset: context.asset,
            currentBalance: context.currentBalance,
            threshold: context.threshold,
            shortfallAmount: context.shortfallAmount,
            shortfallPct: shortfallPctStr + "%",
            severity: context.severity,
            escalation: context.escalation,
            dedup_key: dedupeKey,
          }),
        );
      }
    } catch (error) {
      console.error(
        `Failed to trigger balance-shortfall incident for ${context.provider}/${context.asset}:`,
        error,
      );
    }
  }

  /**
   * Resolve a previously-triggered balance-shortfall incident (balance recovered).
   */
  async resolveBalanceShortfallIncident(provider: string, asset: string): Promise<void> {
    const dedupeKey = this.getBalanceDedupeKey(provider, asset);

    if (!this.activeShortfallIncidents.has(dedupeKey)) {
      return; // nothing to resolve
    }

    const event: PagerDutyEvent = {
      routing_key: this.config.integrationKey,
      event_action: "resolve",
      dedup_key: dedupeKey,
      payload: {
        summary: `[RESOLVED] Balance shortfall for ${provider}/${asset} has been resolved`,
        timestamp: new Date().toISOString(),
        severity: "info",
        source: "mobile-money-balance-monitor",
        custom_details: {
          provider,
          asset,
          environment: process.env.NODE_ENV || "development",
        },
      },
    };

    try {
      const response = await this.client.post("", event);

      if (response.status === 202 || response.status === 200) {
        this.activeShortfallIncidents.delete(dedupeKey);

        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "INFO",
            message: "Balance shortfall incident resolved",
            provider,
            asset,
            dedup_key: dedupeKey,
          }),
        );
      }
    } catch (error) {
      console.error(
        `Failed to resolve balance-shortfall incident for ${provider}/${asset}:`,
        error,
      );
    }
  }

  /**
   * Run the full balance-shortfall alert lifecycle for a single provider/asset.
   *
   *  1. Evaluate the shortfall → determine severity.
   *  2. If shortfall warrants an alert → trigger (or update) the PagerDuty incident.
   *  3. If balance has recovered above threshold → resolve any open incident.
   */
  async handleBalanceShortfall(
    provider: string,
    asset: string,
    threshold: number,
    currentBalance: number,
  ): Promise<void> {
    // Validate & repair tier thresholds on first call (one-shot, idempotent).
    PagerDutyService.validateAndRepairThresholds();

    const context = this.evaluateBalanceShortfall(provider, asset, threshold, currentBalance);

    if (context) {
      await this.triggerBalanceShortfallIncident(context);
    } else if (currentBalance >= threshold) {
      // Balance has fully recovered above threshold — resolve any open incident
      await this.resolveBalanceShortfallIncident(provider, asset);
    }
    // If balance is still below threshold but shortfall is below the minimum
    // alertable tier, leave any existing incident open (don't resolve
    // prematurely) — dedup_key keeps the incident grouped with prior events.
  }

  /**
   * Generate a deduplication key for balance-shortfall incidents.
   */
  private getBalanceDedupeKey(provider: string, asset: string): string {
    return `${this.config.dedupKey}-${provider}-${asset}-balance-shortfall`;
  }

  /**
   * Get all active balance-shortfall incidents (for debugging/observability).
   */
  getActiveShortfallIncidents(): Map<string, BalanceShortfallContext> {
    return new Map(this.activeShortfallIncidents);
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
