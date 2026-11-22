import cron, { ScheduledTask } from "node-cron";
import { Histogram } from "prom-client";
import { register } from "../utils/metrics";
import { reportCriticalAlert } from "../monitoring/alertManager";
import logger from "../utils/logger";

export interface SyntheticProbeResult {
  depositTransactionId: string;
  withdrawalTransactionId: string;
}

export type SyntheticProbeExecutor = (
  amount: string,
  network: "testnet",
) => Promise<SyntheticProbeResult>;

export type SyntheticProbeAlert = (error: Error) => Promise<void> | void;

export const syntheticTransactionDurationSeconds = new Histogram({
  name: "synthetic_transaction_duration_seconds",
  help: "End-to-end duration of the Stellar testnet synthetic deposit and withdrawal",
  labelNames: ["status"],
  buckets: [1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export class SyntheticProbeWorker {
  private consecutiveFailures = 0;
  private task: ScheduledTask | null = null;

  constructor(
    private readonly execute: SyntheticProbeExecutor,
    private readonly alert: SyntheticProbeAlert = async (error) => {
      await reportCriticalAlert({
        source: "synthetic-probe",
        message: error.message,
        error,
      });
    },
  ) {}

  async runOnce(): Promise<SyntheticProbeResult> {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await this.execute("0.01", "testnet");
      if (!result.depositTransactionId || !result.withdrawalTransactionId) {
        throw new Error(
          "Synthetic probe did not complete both transaction legs",
        );
      }
      this.consecutiveFailures = 0;
      syntheticTransactionDurationSeconds.observe(
        { status: "success" },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
      logger.info(
        {
          depositTransactionId: result.depositTransactionId,
          withdrawalTransactionId: result.withdrawalTransactionId,
        },
        "[SyntheticProbe] Testnet roundtrip completed",
      );
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      syntheticTransactionDurationSeconds.observe(
        { status: "failure" },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
      logger.error(
        { error, consecutiveFailures: this.consecutiveFailures },
        "[SyntheticProbe] Testnet roundtrip failed",
      );
      if (this.consecutiveFailures === 2) {
        await this.alert(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    }
  }

  start(schedule = "*/5 * * * *"): boolean {
    if (this.task) return true;
    if (
      process.env.SYNTHETIC_PROBE_ENABLED !== "true" ||
      process.env.STELLAR_NETWORK !== "testnet" ||
      !process.env.SYNTHETIC_PROBE_URL
    ) {
      logger.info(
        "[SyntheticProbe] Disabled; enable only with a testnet probe runner URL",
      );
      return false;
    }
    if (!cron.validate(schedule)) {
      logger.error({ schedule }, "[SyntheticProbe] Invalid schedule");
      return false;
    }

    this.task = cron.schedule(schedule, () => {
      void this.runOnce().catch(() => undefined);
    });
    void this.runOnce().catch(() => undefined);
    return true;
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }
}

export function createHttpSyntheticProbeExecutor(
  url = process.env.SYNTHETIC_PROBE_URL,
  token = process.env.SYNTHETIC_PROBE_TOKEN,
): SyntheticProbeExecutor {
  if (!url) throw new Error("SYNTHETIC_PROBE_URL is required");
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("Synthetic probe runner URL must use HTTPS in production");
  }

  return async (amount, network) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          amount,
          network,
          lifecycle: ["deposit", "withdrawal"],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Synthetic probe runner returned HTTP ${response.status}`,
        );
      }
      const result = (await response.json()) as {
        deposit?: { status?: string; transactionId?: string };
        withdrawal?: { status?: string; transactionId?: string };
      };
      if (
        result.deposit?.status !== "completed" ||
        result.withdrawal?.status !== "completed" ||
        !result.deposit.transactionId ||
        !result.withdrawal.transactionId
      ) {
        throw new Error(
          "Synthetic probe runner did not confirm a completed roundtrip",
        );
      }
      return {
        depositTransactionId: result.deposit.transactionId,
        withdrawalTransactionId: result.withdrawal.transactionId,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const syntheticProbeWorker = new SyntheticProbeWorker(
  (amount, network) => createHttpSyntheticProbeExecutor()(amount, network),
);

export function startSyntheticProbeWorker(): boolean {
  return syntheticProbeWorker.start();
}

export function stopSyntheticProbeWorker(): void {
  syntheticProbeWorker.stop();
}
