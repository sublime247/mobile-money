import logger from "../utils/logger";
import IORedis from "ioredis";
import { SubscriptionChannels } from "../graphql/subscriptions";
import { notificationRouter } from "../services/notificationRouter";
import { TransactionModel } from "../models/transaction";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisOptions: any = {
  retryStrategy: (times: number) => Math.min(100 + times * 200, 3000),
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  lazyConnect: false,
};

let subscriber: IORedis | null = null;

/**
 * Notification worker — subscribes to transaction update channels in Redis
 * and routes user-facing notifications (email/sms/push/etc.) via
 * `NotificationRouter`. This replaces DB polling for notification triggers.
 */
export async function startNotificationWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    console.warn(
      "NotificationWorker: REDIS_URL not set — running without Redis subscription",
    );
    return;
  }

  subscriber = new IORedis(REDIS_URL, redisOptions);

  subscriber.on("connect", () => console.log("NotificationWorker: Redis connected"));
  subscriber.on("error", (err) =>
    logger.error("NotificationWorker: Redis error:", err),
  );

  await subscriber.connect();

  // Subscribe to broadcast updates and per-transaction channels (pattern)
  await subscriber.subscribe(SubscriptionChannels.TRANSACTION_UPDATED);
  await subscriber.psubscribe("TRANSACTION_UPDATED:*");

  subscriber.on("message", async (_channel: string, rawMessage: string) => {
    try {
      const payload = JSON.parse(rawMessage) as {
        id?: string;
        status?: string;
        [key: string]: any;
      };

      const txId = payload.id;
      const status = payload.status;
      if (!txId || !status) return;

      const txModel = new TransactionModel();
      const tx = await txModel.findById(txId);
      if (!tx) return;

      if (status === "completed") {
        await notificationRouter.routeTransactionNotification(tx, "completed");
      } else if (status === "failed") {
        await notificationRouter.routeTransactionNotification(tx, "failed", payload.error);
      }
    } catch (err) {
      logger.error("NotificationWorker: failed to handle message:", err);
    }
  });

  // pmessage handles pattern subscriptions (TRANSACTION_UPDATED:<id>)
  subscriber.on(
    "pmessage",
    async (_pattern: string, _channel: string, rawMessage: string) => {
      try {
        const payload = JSON.parse(rawMessage) as {
          id?: string;
          status?: string;
          [key: string]: any;
        };

        const txId = payload.id;
        const status = payload.status;
        if (!txId || !status) return;

        const txModel = new TransactionModel();
        const tx = await txModel.findById(txId);
        if (!tx) return;

        if (status === "completed") {
          await notificationRouter.routeTransactionNotification(tx, "completed");
        } else if (status === "failed") {
          await notificationRouter.routeTransactionNotification(tx, "failed", payload.error);
        }
      } catch (err) {
        logger.error("NotificationWorker: failed to handle pmessage:", err);
      }
    },
  );

  console.log("NotificationWorker: subscribed to transaction update channels");
}

export async function stopNotificationWorker(): Promise<void> {
  try {
    if (!subscriber) return;
    await subscriber.unsubscribe(SubscriptionChannels.TRANSACTION_UPDATED);
    await subscriber.punsubscribe("TRANSACTION_UPDATED:*");
    await subscriber.quit();
    subscriber = null;
    console.log("NotificationWorker: stopped");
  } catch (err) {
    console.warn("NotificationWorker: stop error:", err);
  }
}
