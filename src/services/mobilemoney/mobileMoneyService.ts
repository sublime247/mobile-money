import { MTNProvider } from "./providers/mtn";
import { AirtelService } from "./providers/airtel";
import { OrangeProvider } from "./providers/orange";
import {
  transactionTotal,
  transactionErrorsTotal,
  providerFailoverTotal,
  providerFailoverAlerts,
} from "../../utils/metrics";
import { pool } from "../../config/database";
import { MonitoringService } from "../monitoringService";

interface MobileMoneyProvider {
  requestPayment(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendPayout(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
}

class MobileMoneyError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "MobileMoneyError";
  }
}

export class MobileMoneyService {
  private providers: Map<string, MobileMoneyProvider>;
  // In-memory failover history: provider -> timestamps of failovers
  private failoverHistory: Map<string, number[]> = new Map();

  constructor(providers?: Map<string, MobileMoneyProvider>) {
    // Allow dependency injection for tests; otherwise create default providers
    this.providers =
      providers ??
      new Map<string, MobileMoneyProvider>([
        ["mtn", new MTNProvider()],
        ["airtel", new AirtelService()],
        ["orange", new OrangeProvider()],
      ]);
  }

  private failoverEnabled(): boolean {
    return (
      String(process.env.PROVIDER_FAILOVER_ENABLED || "false").toLowerCase() ===
      "true"
    );
  }

  private getBackupProviderKey(primary: string): string | null {
    // Read env variable PROVIDER_BACKUP_<UPPER>
    const envKey = `PROVIDER_BACKUP_${primary.toUpperCase()}`;
    const val = process.env[envKey];
    return val ? val.toLowerCase() : null;
  }

  private recordFailover(provider: string) {
    const now = Date.now();
    const arr = this.failoverHistory.get(provider) ?? [];
    arr.push(now);
    // keep only last 100 entries to avoid unbounded growth
    this.failoverHistory.set(provider, arr.slice(-100));
  }

  private checkRepeatedFailovers(provider: string): boolean {
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour
    const THRESHOLD = 3; // alert after 3 failovers in window
    const now = Date.now();
    const arr = this.failoverHistory.get(provider) ?? [];
    const recent = arr.filter((t) => now - t <= WINDOW_MS);
    return recent.length >= THRESHOLD;
  }

  private notifyRepeatedFailovers(provider: string) {
    // Simple notify: log and increment metric
    console.error(
      `Failover alert: provider=${provider} experienced repeated failovers`,
    );
    providerFailoverAlerts.inc({ provider });
  }

  private async attemptWithFailover(
    op: "requestPayment" | "sendPayout",
    primaryKey: string,
    phoneNumber: string,
    amount: string,
  ) {
    const primary = this.providers.get(primaryKey);
    if (!primary) {
      const availableProviders = Array.from(this.providers.keys()).join(", ");
      throw new MobileMoneyError(
        "PROVIDER_NOT_SUPPORTED",
        `Provider '${primaryKey}' not supported. Available: ${availableProviders}`,
      );
    }

    // Helper to call operation on a provider instance
    const call = async (prov: MobileMoneyProvider) => {
      if (op === "requestPayment")
        return prov.requestPayment(phoneNumber, amount);
      return prov.sendPayout(phoneNumber, amount);
    };

    // Try primary
    try {
      const res = await call(primary);
      if (res.success)
        return { success: true, provider: primaryKey, data: res.data };
      // primary returned failure — treat as provider failure and fall through to failover
      throw new Error("provider_failure");
    } catch (err: unknown) {
      // Record metrics for primary failure
      transactionTotal.inc({
        type: op === "requestPayment" ? "payment" : "payout",
        provider: primaryKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: op === "requestPayment" ? "payment" : "payout",
        provider: primaryKey,
        error_type: "provider_or_exception",
      });

      // If failover not enabled, rethrow as MobileMoneyError
      if (!this.failoverEnabled()) {
        throw new MobileMoneyError(
          "PROVIDER_ERROR",
          `Primary provider '${primaryKey}' failed`,
        );
      }

      const backupKey = this.getBackupProviderKey(primaryKey);
      if (!backupKey) {
        // no backup configured
        throw new MobileMoneyError(
          "PROVIDER_ERROR",
          `Primary provider '${primaryKey}' failed and no backup configured`,
        );
      }

      const backup = this.providers.get(backupKey);
      if (!backup) {
        throw new MobileMoneyError(
          "PROVIDER_ERROR",
          `Backup provider '${backupKey}' not available`,
        );
      }

      // Attempt backup
      console.warn(`Failing over from ${primaryKey} to ${backupKey} for ${op}`);
      providerFailoverTotal.inc({
        type: op === "requestPayment" ? "payment" : "payout",
        from_provider: primaryKey,
        to_provider: backupKey,
        reason: String(err instanceof Error ? err.message : err),
      });
      this.recordFailover(primaryKey);
      if (this.checkRepeatedFailovers(primaryKey)) {
        this.notifyRepeatedFailovers(primaryKey);
      }

      try {
        const res2 = await call(backup);
        if (res2.success)
          return { success: true, provider: backupKey, data: res2.data };
        // backup also failed
        throw new Error("backup_provider_failure");
      } catch (err2: unknown) {
        // Both failed — surface as provider error
        throw new MobileMoneyError(
          "PROVIDER_ERROR",
          `Both primary '${primaryKey}' and backup '${backupKey}' failed`,
        );
      }
    }
  }

  async initiatePayment(provider: string, phoneNumber: string, amount: string) {
    const providerKey = provider.toLowerCase();

    const result = await this.attemptWithFailover(
      "requestPayment",
      providerKey,
      phoneNumber,
      amount,
    );

    // result shape: { success: true, provider: <usedProvider>, data }
    if (result.success) {
      transactionTotal.inc({
        type: "payment",
        provider: result.provider as string,
        status: "success",
      });
      return { success: true, data: result.data };
    }

    // Shouldn't reach here; safeguard
    throw new MobileMoneyError(
      "PROVIDER_ERROR",
      `Payment failed for provider '${providerKey}'`,
    );
  }

  async sendPayout(provider: string, phoneNumber: string, amount: string) {
    const providerKey = provider.toLowerCase();

    const result = await this.attemptWithFailover(
      "sendPayout",
      providerKey,
      phoneNumber,
      amount,
    );

    if (result.success) {
      transactionTotal.inc({
        type: "payout",
        provider: result.provider as string,
        status: "success",
      });
      return { success: true, data: result.data };
    }

    throw new MobileMoneyError(
      "PROVIDER_ERROR",
      `Payout failed for provider '${providerKey}'`,
    );
  }

  /**
   * Get failover statistics for all providers.
   * Used by health check endpoint.
   */
  getFailoverStats(): Record<
    string,
    { failover_count: number; last_failover?: number }
  > {
    const stats: Record<
      string,
      { failover_count: number; last_failover?: number }
    > = {};

    for (const [provider, history] of this.failoverHistory.entries()) {
      stats[provider] = {
        failover_count: history.length,
        last_failover:
          history.length > 0 ? history[history.length - 1] : undefined,
      };
    }

    return stats;
  }
}
