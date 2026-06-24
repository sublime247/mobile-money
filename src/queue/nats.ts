import logger from "../utils/logger";
import { connect, StringCodec, consumerOpts, type NatsConnection, type JsMsg } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

export const NATS_QUEUE_ENABLED = process.env.NATS_QUEUE_ENABLED === "true";
export const NATS_SUBJECT = process.env.NATS_SUBJECT || "callbacks.ingest";
export const NATS_DURABLE_CONSUMER =
  process.env.NATS_DURABLE_CONSUMER || "transaction-processing-consumer";
export const NATS_CONSUMER_GROUP =
  process.env.NATS_CONSUMER_GROUP || "transaction-processing-group";
export const NATS_ACK_WAIT_MS = Math.max(
  1000,
  parseInt(process.env.NATS_ACK_WAIT_MS || "30000", 10),
);

class NatsManager {
  private connection: NatsConnection | null = null;
  private sc = StringCodec();

  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    this.connection = await connect({ servers: NATS_URL });
    console.log("[NATS] connected to", NATS_URL);
  }

  async consume<T>(
    subject: string,
    durable: string,
    queueGroup: string,
    onMessage: (data: T, msg: JsMsg) => Promise<void>,
    concurrency: number = 5,
  ): Promise<void> {
    await this.connect();

    if (!this.connection) {
      throw new Error("NATS connection did not initialize");
    }

    const js = this.connection.jetstream();
    const opts = consumerOpts();
    opts.durable(durable);
    opts.queue(queueGroup);
    opts.manualAck();
    opts.maxAckPending(concurrency * 2);
    opts.ackWait(NATS_ACK_WAIT_MS);
    const subscription = await js.subscribe(subject, opts);

    const activeMessages = new Set<Promise<void>>();

    const drainActive = async (): Promise<void> => {
      if (activeMessages.size < concurrency) {
        return;
      }
      await Promise.race(activeMessages);
    };

    for await (const msg of subscription) {
      await drainActive();

      const handler = (async () => {
        let payload: T;

        try {
          payload = JSON.parse(this.sc.decode(msg.data)) as T;
        } catch (error) {
          logger.error("[NATS] Failed to parse message payload", error);
          msg.term();
          return;
        }

        try {
          await onMessage(payload, msg);
          msg.ack();
        } catch (error) {
          logger.error("[NATS] Error processing message", error);
          msg.nak();
        }
      })();

      activeMessages.add(handler);
      handler.finally(() => activeMessages.delete(handler));
    }

    await Promise.all(activeMessages);
  }

  async close(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      await this.connection.close();
      console.log("[NATS] connection closed");
    } catch (error) {
      logger.error("[NATS] failed to close connection", error);
    } finally {
      this.connection = null;
    }
  }
}

export const natsManager = new NatsManager();
export type { JsMsg };
