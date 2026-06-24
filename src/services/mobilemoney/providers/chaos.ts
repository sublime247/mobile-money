import { MobileMoneyProvider, ProviderTransactionStatus } from "../mobileMoneyService";
import logger from "../../../utils/logger";

export interface ChaosConfig {
  enabled: boolean;
  latencyChance: number; // 0 to 1
  latencyMinMs?: number;
  latencyMaxMs?: number;
  latencyMs?: number;
  errorChance: number; // 0 to 1
  dropChance: number; // 0 to 1
}

type NormalizedChaosConfig = ChaosConfig & {
  latencyMinMs: number;
  latencyMaxMs: number;
};

const DEFAULT_CHAOS_CONFIG: NormalizedChaosConfig = {
  enabled: false,
  latencyChance: 0,
  latencyMinMs: 0,
  latencyMaxMs: 0,
  errorChance: 0,
  dropChance: 0,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeLatencyBounds(minMs: number, maxMs: number): Pick<NormalizedChaosConfig, "latencyMinMs" | "latencyMaxMs"> {
  const lower = Math.max(0, Math.floor(minMs));
  const upper = Math.max(0, Math.floor(maxMs));

  return lower <= upper
    ? { latencyMinMs: lower, latencyMaxMs: upper }
    : { latencyMinMs: upper, latencyMaxMs: lower };
}

export function getChaosConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NormalizedChaosConfig {
  const latencyMaxFallback = parseNumber(env.CHAOS_LATENCY_MS, DEFAULT_CHAOS_CONFIG.latencyMaxMs);
  const latencyMinMs = parseNumber(env.CHAOS_LATENCY_MIN_MS, DEFAULT_CHAOS_CONFIG.latencyMinMs);
  const latencyMaxMs = parseNumber(env.CHAOS_LATENCY_MAX_MS, latencyMaxFallback);

  return {
    enabled: parseBoolean(env.CHAOS_ENABLED, DEFAULT_CHAOS_CONFIG.enabled),
    latencyChance: clampRatio(parseNumber(env.CHAOS_LATENCY_CHANCE, DEFAULT_CHAOS_CONFIG.latencyChance)),
    ...normalizeLatencyBounds(latencyMinMs, latencyMaxMs),
    errorChance: clampRatio(parseNumber(env.CHAOS_ERROR_CHANCE, DEFAULT_CHAOS_CONFIG.errorChance)),
    dropChance: clampRatio(parseNumber(env.CHAOS_DROP_CHANCE, DEFAULT_CHAOS_CONFIG.dropChance)),
  };
}

function normalizeConfig(config: ChaosConfig): NormalizedChaosConfig {
  const latencyMaxMs = config.latencyMaxMs ?? config.latencyMs ?? DEFAULT_CHAOS_CONFIG.latencyMaxMs;

  return {
    enabled: config.enabled,
    latencyChance: clampRatio(config.latencyChance),
    ...normalizeLatencyBounds(config.latencyMinMs ?? 0, latencyMaxMs),
    latencyMs: config.latencyMs,
    errorChance: clampRatio(config.errorChance),
    dropChance: clampRatio(config.dropChance),
  };
}

export class ChaosMiddleware implements MobileMoneyProvider {
  private config: NormalizedChaosConfig;

  constructor(
    private inner: MobileMoneyProvider,
    config: ChaosConfig = getChaosConfigFromEnv(),
  ) {
    this.config = normalizeConfig(config);
  }

  private shouldInject(chance: number): boolean {
    return this.config.enabled && Math.random() < chance;
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async applyChaos<T>(operation: () => Promise<T>, requestId?: string): Promise<T> {
    const log = requestId ? logger.child({ requestId }) : logger;
    
    if (!this.config.enabled) {
      return operation();
    }

    // 1. Latency injection
    if (this.shouldInject(this.config.latencyChance)) {
      const { latencyMinMs, latencyMaxMs } = this.config;
      const delay = latencyMinMs + Math.floor(Math.random() * (latencyMaxMs - latencyMinMs + 1));
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

  async requestPayment(phoneNumber: string, amount: string, requestId?: string) {
    return this.applyChaos(() => this.inner.requestPayment(phoneNumber, amount, requestId), requestId);
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    return this.applyChaos(() => this.inner.sendPayout(phoneNumber, amount, requestId), requestId);
  }

  async getTransactionStatus(referenceId: string): Promise<{ status: ProviderTransactionStatus }> {
    if (this.inner.getTransactionStatus) {
      return this.applyChaos(() => this.inner.getTransactionStatus!(referenceId));
    }
    return { status: "unknown" };
  }
}
