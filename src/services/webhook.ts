import { createHmac } from "crypto";
import {
  Transaction,
  WebhookDeliveryUpdate,
} from "../models/transaction";

export type WebhookEvent = "transaction.completed" | "transaction.failed";
export type WebhookDeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "skipped";

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, string>;
}

/**
 * Flat webhook payload optimized for Zapier/Make.com
 */
export interface FlatWebhookPayload {
  event_id: string;
  event_type: WebhookEvent;
  timestamp: string;
  transaction_id: string;
  reference_number: string;
  transaction_type: "deposit" | "withdraw";
  amount: string;
  currency: string;
  phone_number: string;
  provider: string;
  stellar_address: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  user_id?: string;
  notes?: string;
  tags?: string;
  created_at: string;
  updated_at?: string;
  metadata_key?: string;
  metadata_value?: string;
  webhook_delivery_status?: string;
  webhook_delivered_at?: string;
}

export interface WebhookDeliveryResult {
  status: Exclude<WebhookDeliveryStatus, "pending">;
  attempts: number;
  statusCode?: number;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  lastError?: string | null;
}

interface WebhookLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface WebhookServiceOptions {
  fetchImpl?: typeof fetch;
  webhookUrl?: string;
  webhookSecret?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  logger?: WebhookLogger;
}

interface WebhookTransactionModel {
  findById(id: string): Promise<Transaction | null>;
  updateWebhookDelivery(
    id: string,
    delivery: WebhookDeliveryUpdate,
  ): Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStringValue(
  transaction: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = transaction[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }

  return undefined;
}

function toWebhookData(transaction: Transaction): Record<string, string> {
  const record = transaction as unknown as Record<string, unknown>;
  const data: Record<string, string> = {};

  const mappings: Array<[string, string[]]> = [
    ["id", ["id"]],
    ["referenceNumber", ["referenceNumber", "reference_number"]],
    ["type", ["type"]],
    ["amount", ["amount"]],
    ["status", ["status"]],
    ["phoneNumber", ["phoneNumber", "phone_number"]],
    ["provider", ["provider"]],
    ["stellarAddress", ["stellarAddress", "stellar_address"]],
    ["userId", ["userId", "user_id"]],
  ];

  for (const [targetKey, sourceKeys] of mappings) {
    const value = getStringValue(record, ...sourceKeys);
    if (value) {
      data[targetKey] = value;
    }
  }

  return data;
}

export class WebhookService {
  private readonly fetchImpl: typeof fetch;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly logger: WebhookLogger;

  constructor(options: WebhookServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webhookUrl = options.webhookUrl ?? process.env.WEBHOOK_URL ?? "";
    this.webhookSecret =
      options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "";
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleepImpl = options.sleep ?? wait;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  buildPayload(event: WebhookEvent, transaction: Transaction): WebhookPayload {
    return {
      event,
      timestamp: this.now().toISOString(),
      data: toWebhookData(transaction),
    };
  }

  buildFlatPayload(event: WebhookEvent, transaction: Transaction): FlatWebhookPayload {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const payload: FlatWebhookPayload = {
      event_id: eventId,
      event_type: event,
      timestamp: this.now().toISOString(),
      
      transaction_id: transaction.id,
      reference_number: transaction.referenceNumber,
      transaction_type: transaction.type,
      amount: transaction.amount,
      currency: (transaction as any).currency || "USD",
      phone_number: transaction.phoneNumber,
      provider: transaction.provider,
      stellar_address: transaction.stellarAddress,
      status: transaction.status,
      
      user_id: transaction.userId || undefined,
      notes: transaction.notes || undefined,
      tags: transaction.tags ? transaction.tags.join(",") : undefined,
      
      created_at: transaction.createdAt.toISOString(),
      updated_at: transaction.updatedAt ? transaction.updatedAt.toISOString() : undefined,
      
      webhook_delivery_status: (transaction as any).webhook_delivery_status,
      webhook_delivered_at: (transaction as any).webhook_delivered_at ? (transaction as any).webhook_delivered_at.toISOString() : undefined
    };

    // Flatten first metadata key-value pair for easy access
    if (transaction.metadata && typeof transaction.metadata === "object") {
      const entries = Object.entries(transaction.metadata);
      if (entries.length > 0) {
        payload.metadata_key = entries[0][0];
        payload.metadata_value = String(entries[0][1]);
      }
    }

    return payload;
  }

  signPayload(rawPayload: string): string {
    return `sha256=${createHmac("sha256", this.webhookSecret)
      .update(rawPayload)
      .digest("hex")}`;
  }

  async sendTransactionEvent(
    event: WebhookEvent,
    transaction: Transaction,
  ): Promise<WebhookDeliveryResult> {
    if (!this.webhookUrl) {
      const message = "WEBHOOK_URL is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    if (!this.webhookSecret) {
      const message = "WEBHOOK_SECRET is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    const payload = this.buildPayload(event, transaction);
    const rawPayload = JSON.stringify(payload);
    const signature = this.signPayload(rawPayload);
    let lastError: string | null = null;
    let lastStatusCode: number | undefined;
    let lastAttemptAt: Date | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      lastAttemptAt = this.now();

      try {
        const response = await this.fetchImpl(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
          },
          body: rawPayload,
        });

        lastStatusCode = response.status;

        if (!response.ok) {
          throw new Error(`Webhook responded with HTTP ${response.status}`);
        }

        this.logger.log(
          `[webhook] delivered event=${event} transactionId=${payload.data.id} attempt=${attempt}`,
        );

        return {
          status: "delivered",
          attempts: attempt,
          statusCode: response.status,
          lastAttemptAt,
          deliveredAt: lastAttemptAt,
          lastError: null,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Unknown webhook error";

        this.logger.warn(
          `[webhook] delivery failed event=${event} transactionId=${payload.data.id} attempt=${attempt}/${this.maxAttempts}: ${lastError}`,
        );

        if (attempt < this.maxAttempts) {
          await this.sleepImpl(this.baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    this.logger.error(
      `[webhook] delivery exhausted event=${event} transactionId=${payload.data.id}: ${lastError}`,
    );

    return {
      status: "failed",
      attempts: this.maxAttempts,
      statusCode: lastStatusCode,
      lastAttemptAt,
      deliveredAt: null,
      lastError,
    };
  }

  async sendFlatTransactionEvent(
    event: WebhookEvent,
    transaction: Transaction,
  ): Promise<WebhookDeliveryResult> {
    if (!this.webhookUrl) {
      const message = "WEBHOOK_URL is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    if (!this.webhookSecret) {
      const message = "WEBHOOK_SECRET is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    const payload = this.buildFlatPayload(event, transaction);
    const rawPayload = JSON.stringify(payload);
    const signature = this.signPayload(rawPayload);
    let lastError: string | null = null;
    let lastStatusCode: number | undefined;
    let lastAttemptAt: Date | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      lastAttemptAt = this.now();

      try {
        const response = await this.fetchImpl(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
          },
          body: rawPayload,
        });

        lastStatusCode = response.status;

        if (!response.ok) {
          throw new Error(`Webhook responded with HTTP ${response.status}`);
        }

        this.logger.log(
          `[webhook] delivered flat event=${event} transactionId=${payload.transaction_id} attempt=${attempt}`,
        );

        return {
          status: "delivered",
          attempts: attempt,
          statusCode: response.status,
          lastAttemptAt,
          deliveredAt: lastAttemptAt,
          lastError: null,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Unknown webhook error";

        this.logger.warn(
          `[webhook] delivery failed flat event=${event} transactionId=${payload.transaction_id} attempt=${attempt}/${this.maxAttempts}: ${lastError}`,
        );

        if (attempt < this.maxAttempts) {
          await this.sleepImpl(this.baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    this.logger.error(
      `[webhook] delivery exhausted flat event=${event} transactionId=${payload.transaction_id}: ${lastError}`,
    );

    return {
      status: "failed",
      attempts: this.maxAttempts,
      statusCode: lastStatusCode,
      lastAttemptAt,
      deliveredAt: null,
      lastError,
    };
  }
}

export async function notifyTransactionWebhook(
  transactionId: string,
  event: WebhookEvent,
  dependencies: {
    transactionModel: WebhookTransactionModel;
    webhookService?: WebhookService;
    logger?: WebhookLogger;
  },
): Promise<WebhookDeliveryResult | null> {
  const webhookService =
    dependencies.webhookService ?? new WebhookService();
  const logger = dependencies.logger ?? console;
  const transaction = await dependencies.transactionModel.findById(transactionId);

  if (!transaction) {
    logger.warn(
      `[webhook] skipped event=${event} transactionId=${transactionId}: transaction not found`,
    );
    return null;
  }

  const result = await webhookService.sendTransactionEvent(event, transaction);

  await dependencies.transactionModel.updateWebhookDelivery(transactionId, {
    status: result.status,
    lastAttemptAt: result.lastAttemptAt,
    deliveredAt: result.deliveredAt,
    lastError: result.lastError ?? null,
  });

  return result;
}

export async function notifyFlatTransactionWebhook(
  transactionId: string,
  event: WebhookEvent,
  dependencies: {
    transactionModel: WebhookTransactionModel;
    webhookService?: WebhookService;
    logger?: WebhookLogger;
  },
): Promise<WebhookDeliveryResult | null> {
  const webhookService =
    dependencies.webhookService ?? new WebhookService();
  const logger = dependencies.logger ?? console;
  const transaction = await dependencies.transactionModel.findById(transactionId);

  if (!transaction) {
    logger.warn(
      `[webhook] skipped flat event=${event} transactionId=${transactionId}: transaction not found`,
    );
    return null;
  }

  const result = await webhookService.sendFlatTransactionEvent(event, transaction);

  await dependencies.transactionModel.updateWebhookDelivery(transactionId, {
    status: result.status,
    lastAttemptAt: result.lastAttemptAt,
    deliveredAt: result.deliveredAt,
    lastError: result.lastError ?? null,
  });

  return result;
}
