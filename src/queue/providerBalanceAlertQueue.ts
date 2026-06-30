import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const PROVIDER_BALANCE_ALERT_QUEUE_NAME = "provider-balance-alerts";
export const PROVIDER_BALANCE_ALERT_JOB_NAME = "check-provider-balances";

export interface ProviderBalanceAlertJobData {
  triggeredBy: "scheduler";
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

export const providerBalanceAlertQueue = new Queue<ProviderBalanceAlertJobData>(
  PROVIDER_BALANCE_ALERT_QUEUE_NAME,
  queueOptions,
);

function getRepeatIntervalMs(): number {
  const raw = process.env.PROVIDER_BALANCE_ALERT_INTERVAL_MS;
  const parsed = Number.parseInt(raw || "", 10);

  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }

  return parsed;
}

export async function scheduleProviderBalanceAlertJob(): Promise<void> {
  const every = getRepeatIntervalMs();

  await providerBalanceAlertQueue.add(
    PROVIDER_BALANCE_ALERT_JOB_NAME,
    { triggeredBy: "scheduler" },
    {
      jobId: PROVIDER_BALANCE_ALERT_JOB_NAME,
      repeat: { every },
      removeOnComplete: {
        count: 100,
        age: 24 * 3600,
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 3600,
      },
      attempts: Number.parseInt(
        process.env.PROVIDER_BALANCE_ALERT_ATTEMPTS || "3",
        10,
      ),
      backoff: {
        type: "exponential",
        delay: Number.parseInt(
          process.env.PROVIDER_BALANCE_ALERT_BACKOFF_MS || "5000",
          10,
        ),
      },
    },
  );
}

export async function closeProviderBalanceAlertQueue(): Promise<void> {
  await providerBalanceAlertQueue.close();
}
