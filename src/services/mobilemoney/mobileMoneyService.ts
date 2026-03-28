import { MTNProvider } from "./providers/mtn";
import { AirtelService } from "./providers/airtel";
import { OrangeProvider } from "./providers/orange";
import {
  transactionTotal,
  transactionErrorsTotal,
  providerFailoverTotal,
  providerFailoverAlerts,
} from "../../utils/metrics";
import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
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

interface ProviderExecutionResult {
  success: boolean;
  provider?: string;
  data?: unknown;
  error?: unknown;
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
    const result = await this.executeProviderOperation(
      op,
      primaryKey,
      phoneNumber,
      amount,
      true,
    );

    if (result.success) {
      return result;
    }

    throw new MobileMoneyError(
      "PROVIDER_ERROR",
      `Payment flow failed for provider '${primaryKey}'`,
    );
  }

  private getProviderOrThrow(providerKey: string): MobileMoneyProvider {
    const provider = this.providers.get(providerKey);
    if (!provider) {
      const availableProviders = Array.from(this.providers.keys()).join(", ");
      throw new MobileMoneyError(
        "PROVIDER_NOT_SUPPORTED",
        `Provider '${providerKey}' not supported. Available: ${availableProviders}`,
      );
    }

    return provider;
  }

  private async callProvider(
    provider: MobileMoneyProvider,
    op: "requestPayment" | "sendPayout",
    phoneNumber: string,
    amount: string,
  ) {
    if (op === "requestPayment") {
      return provider.requestPayment(phoneNumber, amount);
    }

    return provider.sendPayout(phoneNumber, amount);
  }

  private getOperationType(op: "requestPayment" | "sendPayout") {
    return op === "requestPayment" ? "payment" : "payout";
  }

  private buildProviderFailureMessage(
    providerKey: string,
    error: unknown,
    phase: "primary" | "backup",
  ): string {
    const reason =
      error instanceof Error && error.message
        ? error.message
        : "provider operation failed";

    return `${phase} provider '${providerKey}' failed: ${reason}`;
  }

  private async executeProviderOperation(
    op: "requestPayment" | "sendPayout",
    providerKey: string,
    phoneNumber: string,
    amount: string,
    allowFailover: boolean,
  ): Promise<ProviderExecutionResult> {
    const provider = this.getProviderOrThrow(providerKey);
    const operationType = this.getOperationType(op);
    const backupKey =
      allowFailover && this.failoverEnabled()
        ? this.getBackupProviderKey(providerKey)
        : null;

    try {
      return await executeWithCircuitBreaker({
        provider: providerKey,
        operation: op,
        execute: async () => {
          const result = await this.callProvider(
            provider,
            op,
            phoneNumber,
            amount,
          );

          if (result.success) {
            return {
              success: true,
              provider: providerKey,
              data: result.data,
            };
          }

          return {
            success: false,
            provider: providerKey,
            error: result.error ?? new Error("provider_failure"),
          };
        },
        fallback: backupKey
          ? async (error: unknown) => {
              if (backupKey === providerKey) {
                return {
                  success: false,
                  provider: providerKey,
                  error,
                };
              }

              this.getProviderOrThrow(backupKey);

              console.warn(
                `Failing over from ${providerKey} to ${backupKey} for ${op}`,
              );
              providerFailoverTotal.inc({
                type: operationType,
                from_provider: providerKey,
                to_provider: backupKey,
                reason: String(
                  error instanceof Error ? error.message : error,
                ).slice(0, 100),
              });
              this.recordFailover(providerKey);
              if (this.checkRepeatedFailovers(providerKey)) {
                this.notifyRepeatedFailovers(providerKey);
              }

              return this.executeProviderOperation(
                op,
                backupKey,
                phoneNumber,
                amount,
                false,
              );
            }
          : undefined,
      });
    } catch (error) {
      transactionTotal.inc({
        type: operationType,
        provider: providerKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: operationType,
        provider: providerKey,
        error_type: allowFailover ? "provider_or_exception" : "backup_failure",
      });

      throw new MobileMoneyError(
        "PROVIDER_ERROR",
        this.buildProviderFailureMessage(
          providerKey,
          error,
          allowFailover ? "primary" : "backup",
        ),
      );
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
