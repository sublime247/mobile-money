import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
} from "../mobileMoneyService";
import logger from "../../../utils/logger";

export interface ChaosConfig {
  enabled: boolean;
  latencyChance: number; // 0 to 1
  latencyMs: number;
  errorChance: number; // 0 to 1
  dropChance: number; // 0 to 1
}

export class ChaosMiddleware implements MobileMoneyProvider {
  constructor(
    private inner: MobileMoneyProvider,
    private config: ChaosConfig,
  ) {}

  private shouldInject(chance: number): boolean {
    return this.config.enabled && Math.random() < chance;
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async applyChaos<T>(
    operation: () => Promise<T>,
    requestId?: string,
  ): Promise<T> {
    const log = requestId ? logger.child({ requestId }) : logger;

    if (!this.config.enabled) {
      return operation();
    }

    // 1. Latency injection
    if (this.shouldInject(this.config.latencyChance)) {
      const delay = Math.floor(Math.random() * this.config.latencyMs);
      log.info({ delay }, "Chaos: Injecting latency");
      await this.sleep(delay);
    }

    // 2. Connectivity drops (immediate failure or timeout simulation)
    if (this.shouldInject(this.config.dropChance)) {
      log.warn("Chaos: Simulating connectivity drop");
      throw new Error("Chaos: Connectivity drop (ECONNRESET)");
    }

    // 3. 500 Errors (random application-level failure)
    if (this.shouldInject(this.config.errorChance)) {
      log.warn("Chaos: Injecting 500 error");
      // Return a failure result that looks like a 500 from a provider
      return {
        success: false,
        error: {
          message: "Internal Server Error",
          code: "INTERNAL_ERROR",
          status: 500,
        },
      } as any;
    }

    return operation();
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    return this.applyChaos(
      () => this.inner.requestPayment(phoneNumber, amount, requestId),
      requestId,
    );
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    return this.applyChaos(
      () => this.inner.sendPayout(phoneNumber, amount, requestId),
      requestId,
    );
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    if (this.inner.getTransactionStatus) {
      return this.applyChaos(() =>
        this.inner.getTransactionStatus!(referenceId),
      );
    }
    return { status: "unknown" };
  }
}
