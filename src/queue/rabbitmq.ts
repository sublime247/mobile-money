import logger from "../utils/logger";
import amqp, { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, Message } from "amqplib";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";

export const EXCHANGES = {
  TRANSACTIONS: "transactions.topic",
};

export const ROUTING_KEYS = {
  TRANSACTION_PROCESS: "transaction.process",
  TRANSACTION_COMPLETED: "transaction.completed",
  TRANSACTION_FAILED: "transaction.failed",
};

export const QUEUES = {
  TRANSACTION_PROCESSING: "transaction-processing-queue",
};

class RabbitMQManager {
  private connection: AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;

  constructor() {
    this.connection = amqp.connect([RABBITMQ_URL]);
    this.connection.on("connect", () => console.log("Connected to RabbitMQ"));
    this.connection.on("disconnect", (err) => logger.error("Disconnected from RabbitMQ", err.err));

    this.channelWrapper = this.connection.createChannel({
      json: true,
      setup: async (channel: ConfirmChannel) => {
        await Promise.all([
          channel.assertExchange(EXCHANGES.TRANSACTIONS, "topic", { durable: true }),
          channel.assertQueue(QUEUES.TRANSACTION_PROCESSING, { durable: true }),
          channel.bindQueue(
            QUEUES.TRANSACTION_PROCESSING,
            EXCHANGES.TRANSACTIONS,
            ROUTING_KEYS.TRANSACTION_PROCESS
          ),
        ]);
      },
    });
  }

  async publish(exchange: string, routingKey: string, data: any) {
    try {
      await this.channelWrapper.publish(exchange, routingKey, data, {
        persistent: true,
      });
      console.log(`[RabbitMQ] Published message to ${exchange} with key ${routingKey}`);
    } catch (error) {
      logger.error(`[RabbitMQ] Failed to publish message:`, error);
      throw error;
    }
  }

  async consume<T>(
    queue: string,
    onMessage: (data: T, msg: Message) => Promise<void>,
    concurrency: number = 5
  ) {
    await this.channelWrapper.addSetup(async (channel: ConfirmChannel) => {
      await channel.prefetch(concurrency);
      await channel.consume(queue, async (msg) => {
        if (msg) {
          try {
            const content = msg.content.toString();
            const data = JSON.parse(content) as T;
            await onMessage(data, msg);
            channel.ack(msg);
          } catch (error) {
            logger.error(`[RabbitMQ] Error processing message from ${queue}:`, error);
            // Default behavior: nack without requeue to avoid infinite loops unless specified
            channel.nack(msg, false, false);
          }
        }
      });
    });
  }

  async close() {
    try {
      await this.channelWrapper.close();
      await this.connection.close();
      console.log("RabbitMQ connection closed");
    } catch (error) {
      logger.error("Error closing RabbitMQ connection:", error);
    }
  }
}

export const rabbitMQManager = new RabbitMQManager();
