import { queryRead, queryWrite } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";

export type SubscriptionInterval = "daily" | "weekly" | "monthly";

export interface SubscriptionRow {
  id: string;
  merchant_id: string;
  user_id?: string | null;
  phone_number?: Buffer | null;
  amount: string;
  currency: string;
  interval: SubscriptionInterval;
  status: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  retry_count: number;
  max_retries: number;
  retry_backoff_seconds: number;
  metadata: any;
}

export class SubscriptionModel {
  async getDueSubscriptions(limit = 100): Promise<SubscriptionRow[]> {
    const res = await queryRead(
      `SELECT * FROM subscriptions WHERE status = 'active' AND next_run_at <= NOW() ORDER BY next_run_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r: any) => ({
      ...r,
      phone_number: r.phone_number ? r.phone_number : null,
    }));
  }

  async create(data: {
    merchant_id: string;
    user_id?: string | null;
    phone_number?: string | null;
    amount: string | number;
    currency?: string;
    interval: SubscriptionInterval;
    next_run_at?: string | null;
    metadata?: any;
    max_retries?: number;
    retry_backoff_seconds?: number;
  }) {
    const res = await queryWrite(
      `INSERT INTO subscriptions (
         merchant_id, user_id, phone_number, amount, currency, interval, next_run_at, metadata, max_retries, retry_backoff_seconds
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        data.merchant_id,
        data.user_id ?? null,
        data.phone_number ? data.phone_number : null,
        String(data.amount),
        data.currency ?? "USD",
        data.interval,
        data.next_run_at ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.max_retries ?? 3,
        data.retry_backoff_seconds ?? 600,
      ],
    );
    return res.rows[0];
  }

  async listByMerchant(merchantId: string) {
    const res = await queryRead(`SELECT * FROM subscriptions WHERE merchant_id = $1 ORDER BY created_at DESC`, [merchantId]);
    return res.rows;
  }

  async update(id: string, fields: Record<string, any>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = $${idx}`);
      params.push(v);
      idx += 1;
    }
    params.push(id);
    const q = `UPDATE subscriptions SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${idx} RETURNING *`;
    const res = await queryWrite(q, params);
    return res.rows[0];
  }

  async delete(id: string) {
    await queryWrite(`DELETE FROM subscriptions WHERE id = $1`, [id]);
  }

  async markRun(subscriptionId: string, nextRunAt: string | null, lastRunAt = new Date().toISOString()) {
    await queryWrite(
      `UPDATE subscriptions SET last_run_at = $1, next_run_at = $2, retry_count = 0, updated_at = NOW() WHERE id = $3`,
      [lastRunAt, nextRunAt, subscriptionId],
    );
  }

  async recordAttempt(subscriptionId: string, transactionId: string | null, attemptNumber: number, status: string, error?: string) {
    await queryWrite(
      `INSERT INTO subscription_attempts (subscription_id, transaction_id, attempt_number, status, error) VALUES ($1,$2,$3,$4,$5)`,
      [subscriptionId, transactionId, attemptNumber, status, error ?? null],
    );
  }

  async incrementRetry(subscriptionId: string) {
    const res = await queryWrite(
      `UPDATE subscriptions SET retry_count = COALESCE(retry_count,0) + 1, updated_at = NOW() WHERE id = $1 RETURNING retry_count, max_retries, retry_backoff_seconds`,
      [subscriptionId],
    );
    return res.rows[0];
  }

  async pause(subscriptionId: string) {
    await queryWrite(`UPDATE subscriptions SET status = 'paused', updated_at = NOW() WHERE id = $1`, [subscriptionId]);
  }

  async resume(subscriptionId: string) {
    await queryWrite(`UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = $1`, [subscriptionId]);
  }

  async getById(id: string) {
    const res = await queryRead(`SELECT * FROM subscriptions WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }
}

export default new SubscriptionModel();
