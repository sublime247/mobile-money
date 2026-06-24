import { queryRead, queryWrite } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";

export interface MerchantWebhook {
  id: string;
  userId: string;
  url: string;
  secret: string;
  description?: string;
  events: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  durationMs?: number;
  isTest: boolean;
  createdAt: Date;
}

export interface CreateWebhookInput {
  userId: string;
  url: string;
  secret: string;
  description?: string;
  events?: string[];
}

export interface UpdateWebhookInput {
  url?: string;
  secret?: string;
  description?: string;
  events?: string[];
  isActive?: boolean;
}

const ALLOWED_EVENTS = new Set([
  "transaction.completed",
  "transaction.failed",
  "transaction.pending",
  "transaction.cancelled",
]);

const MAX_WEBHOOKS_PER_USER = 10;

function validateEvents(events: string[]): void {
  for (const e of events) {
    if (!ALLOWED_EVENTS.has(e)) {
      throw new Error(`Unknown event type: "${e}"`);
    }
  }
}

function mapRow(row: any): MerchantWebhook {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.url,
    secret: decrypt(row.secret) as string,
    description: row.description ?? undefined,
    events: row.events ?? [],
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapLogRow(row: any): WebhookDeliveryLog {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    httpStatus: row.http_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    errorMessage: row.error_message ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    isTest: row.is_test,
    createdAt: new Date(row.created_at),
  };
}

export class MerchantWebhookModel {
  async create(input: CreateWebhookInput): Promise<MerchantWebhook> {
    const events = input.events ?? ["transaction.completed", "transaction.failed"];
    validateEvents(events);

    // Enforce per-user limit
    const countRes = await queryRead(
      "SELECT COUNT(*) FROM merchant_webhooks WHERE user_id = $1",
      [input.userId],
    );
    if (parseInt(countRes.rows[0].count, 10) >= MAX_WEBHOOKS_PER_USER) {
      throw new Error(`Maximum of ${MAX_WEBHOOKS_PER_USER} webhooks per merchant`);
    }

    const res = await queryWrite(
      `INSERT INTO merchant_webhooks (user_id, url, secret, description, events)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.userId, input.url, encrypt(input.secret), input.description ?? null, events],
    );
    return mapRow(res.rows[0]);
  }

  async findById(id: string, userId?: string): Promise<MerchantWebhook | null> {
    let q = "SELECT * FROM merchant_webhooks WHERE id = $1";
    const params: unknown[] = [id];
    if (userId) {
      q += " AND user_id = $2";
      params.push(userId);
    }
    const res = await queryRead(q, params);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByUserId(userId: string): Promise<MerchantWebhook[]> {
    const res = await queryRead(
      "SELECT * FROM merchant_webhooks WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return res.rows.map(mapRow);
  }

  async update(id: string, userId: string, input: UpdateWebhookInput): Promise<MerchantWebhook | null> {
    if (input.events) validateEvents(input.events);

    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.url !== undefined)         { fields.push(`url = $${idx++}`);         params.push(input.url); }
    if (input.secret !== undefined)      { fields.push(`secret = $${idx++}`);      params.push(encrypt(input.secret)); }
    if (input.description !== undefined) { fields.push(`description = $${idx++}`); params.push(input.description); }
    if (input.events !== undefined)      { fields.push(`events = $${idx++}`);      params.push(input.events); }
    if (input.isActive !== undefined)    { fields.push(`is_active = $${idx++}`);   params.push(input.isActive); }

    if (fields.length === 0) return this.findById(id, userId);

    fields.push(`updated_at = NOW()`);
    params.push(id, userId);

    const res = await queryWrite(
      `UPDATE merchant_webhooks SET ${fields.join(", ")}
       WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING *`,
      params,
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const res = await queryWrite(
      "DELETE FROM merchant_webhooks WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Delivery logs ──────────────────────────────────────────────────────────

  async insertDeliveryLog(
    log: Omit<WebhookDeliveryLog, "id" | "createdAt">,
  ): Promise<WebhookDeliveryLog> {
    const res = await queryWrite(
      `INSERT INTO webhook_delivery_logs
         (webhook_id, event_type, payload, status, http_status, response_body, error_message, duration_ms, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        log.webhookId,
        log.eventType,
        JSON.stringify(log.payload),
        log.status,
        log.httpStatus ?? null,
        log.responseBody ?? null,
        log.errorMessage ?? null,
        log.durationMs ?? null,
        log.isTest,
      ],
    );
    return mapLogRow(res.rows[0]);
  }

  async getDeliveryLogs(
    webhookId: string,
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ logs: WebhookDeliveryLog[]; total: number }> {
    // Verify ownership first
    const webhook = await this.findById(webhookId, userId);
    if (!webhook) return { logs: [], total: 0 };

    const [logsRes, countRes] = await Promise.all([
      queryRead(
        `SELECT * FROM webhook_delivery_logs
         WHERE webhook_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [webhookId, limit, offset],
      ),
      queryRead(
        "SELECT COUNT(*) FROM webhook_delivery_logs WHERE webhook_id = $1",
        [webhookId],
      ),
    ]);

    return {
      logs: logsRes.rows.map(mapLogRow),
      total: parseInt(countRes.rows[0].count, 10),
    };
  }
}
