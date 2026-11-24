import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import {
  dispatchWebhookBacklogAlert,
  webhookBacklogAction,
} from "../services/alertService";
import logger from "../utils/logger";
import { queueOptions } from "./config";

export const WEBHOOK_RETRY_QUEUE_NAME = "webhook-callback-retries";

export interface WebhookRetryJobData {
  webhookId: string;
  userId: string;
  url: string;
  secret: string;
  eventType: string;
  payload: Record<string, unknown>;
  useFlatPayload?: boolean;
}

export const webhookRetryQueue = new Queue<WebhookRetryJobData>(
  WEBHOOK_RETRY_QUEUE_NAME,
  queueOptions,
);

const MAX_ATTEMPTS = Number(process.env.WEBHOOK_RETRY_MAX_ATTEMPTS ?? 5);
// Base delay for exponential backoff in ms (default 30s → 30s, 60s, 120s, 240s, 480s)
const BASE_DELAY_MS = Number(process.env.WEBHOOK_RETRY_BASE_DELAY_MS ?? 30_000);

export async function enqueueWebhookRetry(
  data: WebhookRetryJobData,
): Promise<void> {
  await webhookRetryQueue.add("deliver", data, {
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: BASE_DELAY_MS },
    removeOnComplete: { count: 200, age: 7 * 24 * 3600 },
    removeOnFail: { count: 500, age: 30 * 24 * 3600 },
  });
}

const pendingStates = ["waiting", "delayed", "prioritized", "paused"] as const;
let watcher: NodeJS.Timeout | undefined;
let currentCheck: Promise<void> | undefined;
const lockCommand = "webhookRetryBacklogLock";
const registeredLockClients = new WeakSet();

const lockScript = `
  if ARGV[2] then
    return redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX")
  end
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

async function checkWebhookRetryBacklog(routingKey: string): Promise<void> {
  const dedupKey = `${process.env.PAGERDUTY_DEDUP_KEY || "mobile-money"}-webhook-retry-backlog`;
  const stateKey = webhookRetryQueue.toKey(`pagerduty:${dedupKey}`);
  const client = await webhookRetryQueue.client;
  const counts = await webhookRetryQueue.getJobCounts(...pendingStates);
  const depth = pendingStates.reduce(
    (total, state) => total + (counts[state] ?? 0),
    0,
  );

  // Above the depth threshold, the exact age is unnecessary for the decision.
  const oldest =
    depth > 0 && depth <= 500
      ? (await webhookRetryQueue.getJobs([...pendingStates], 0, 499)).reduce(
          (timestamp, job) => Math.min(timestamp, job.timestamp),
          Date.now(),
        )
      : Date.now();
  const backlog = {
    depth,
    ...(depth <= 500 && { oldestAgeSeconds: (Date.now() - oldest) / 1000 }),
  };
  const lockKey = `${stateKey}:lock`;
  const owner = randomUUID();
  if (!registeredLockClients.has(client)) {
    client.defineCommand(lockCommand, { numberOfKeys: 1, lua: lockScript });
    registeredLockClients.add(client);
  }
  if (
    (await client.runCommand(lockCommand, [lockKey, owner, 15_000])) !== "OK"
  ) {
    return;
  }

  try {
    const action = webhookBacklogAction(
      backlog,
      (await client.get(stateKey)) === "trigger",
    );
    if (!action) return;

    await dispatchWebhookBacklogAlert(routingKey, dedupKey, action, backlog);
    if (action === "trigger") await client.set(stateKey, action);
    else await client.del(stateKey);
  } finally {
    await client.runCommand(lockCommand, [lockKey, owner]);
  }
}

export function startWebhookRetryBacklogWatcher(): void {
  const routingKey = process.env.PAGERDUTY_INTEGRATION_KEY;
  if (!routingKey || watcher) return;

  const check = () => {
    if (currentCheck) return;
    currentCheck = checkWebhookRetryBacklog(routingKey)
      .catch(() => {
        // Axios errors can contain the integration key in the request body.
        logger.error("Failed to check or report the webhook retry backlog");
      })
      .finally(() => {
        currentCheck = undefined;
      });
  };
  watcher = setInterval(check, 30_000);
  watcher.unref();
  check();
}

export async function closeWebhookRetryQueue(): Promise<void> {
  clearInterval(watcher);
  watcher = undefined;
  await webhookRetryQueue.close();
}
