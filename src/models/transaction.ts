import { queryRead, queryWrite } from "../config/database";
import { generateReferenceNumber } from "../utils/referenceGenerator";
import { encrypt, decrypt } from "../utils/encryption";
import { WebSocketManager } from "../websocket";
import { getRedisPubSub } from "../graphql/redisPubSub";
import { CachedTransactionInvalidation } from "../services/cachedTransactionService";
import {
  SubscriptionChannels,
  transactionChannel,
  type TransactionUpdatedPayload,
} from "../graphql/subscriptions";

export type AssetType = "native" | "credit_alphanum4" | "credit_alphanum12";

export enum TransactionStatus {
  Pending = "pending",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Review = "review",
  Dispute = "dispute",
  Reversed = "reversed",
  ClawedBack = "clawed_back",
}

export interface Transaction {
  id: string;
  referenceNumber: string;
  type: string;
  amount: string;
  phoneNumber: string;
  provider: string;
  status: TransactionStatus;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: any;
}

export interface TransactionListFilters {
  minAmount?: number;
  maxAmount?: number;
  provider?: string;
  tags?: string[];
  referenceNumber?: string;
  statuses?: TransactionStatus[];
}

export interface TransactionCursorOptions {
  before?: string;
  after?: string;
}

export interface WebhookDeliveryUpdate {
  status: "pending" | "delivered" | "failed" | "skipped";
  lastAttemptAt?: Date | null;
  deliveredAt?: Date | null;
  lastError?: string | null;
}

interface DecodedTransactionCursor {
  createdAt: Date;
  id: string;
}

const MAX_TAGS = 10;
const TAG_REGEX = /^[a-z0-9-]+$/;
const MAX_METADATA_BYTES = 10240;

const TRANSACTION_SELECT_COLUMNS = `
  id,
  reference_number AS "referenceNumber",
  provider_reference AS "providerReference",
  type,
  amount::text AS amount,
  phone_number AS "phoneNumber",
  provider,
  stellar_address AS "stellarAddress",
  status,
  COALESCE(tags, '{}') AS tags,
  notes,
  admin_notes AS "adminNotes",
  COALESCE(metadata, '{}') AS metadata,
  location_metadata AS "locationMetadata",
  user_id AS "userId",
  idempotency_key AS "idempotencyKey",
  idempotency_expires_at AS "idempotencyExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function validateTags(tags: string[]): void {
  if (tags.length > MAX_TAGS)
    throw new Error(`Maximum ${MAX_TAGS} tags allowed`);
  for (const tag of tags) {
    if (!TAG_REGEX.test(tag)) throw new Error(`Invalid tag format: "${tag}"`);
  }
}

function validateMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Metadata must be a JSON object");
  }
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new Error(`Metadata exceeds ${MAX_METADATA_BYTES / 1024} KB`);
  }
  return metadata as Record<string, unknown>;
}

function decodeTransactionCursor(cursor: string): DecodedTransactionCursor {
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const separator = decoded.lastIndexOf("|");

  if (separator === -1) {
    throw new Error("Invalid transaction cursor");
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw new Error("Invalid transaction cursor");
  }

  return { createdAt, id };
}

function normalizeEndDate(endDate: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    ? new Date(`${endDate}T23:59:59.999Z`)
    : new Date(endDate);
}

export function mapTransactionRow(row: any): any {
  if (!row) return null;

  return {
    id: String(row.id),
    referenceNumber: row.referenceNumber,
    type: row.type,
    amount: String(row.amount),
    phoneNumber: decrypt(row.phoneNumber),
    provider: row.provider,
    stellarAddress: decrypt(row.stellarAddress),
    status: row.status,
    tags: row.tags ?? [],
    notes: decrypt(row.notes ?? null) ?? undefined,
    adminNotes: decrypt(row.adminNotes ?? null) ?? undefined,
    metadata: row.metadata ?? {},
    locationMetadata: row.locationMetadata ?? null,
    userId: row.userId ?? null,
    assetType: row.assetType ?? "native",
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    currency: row.currency ?? "USD",
    originalAmount: row.originalAmount ?? row.amount,
    convertedAmount: row.convertedAmount,
    idempotencyKey: row.idempotencyKey,
    idempotencyExpiresAt: row.idempotencyExpiresAt
      ? new Date(row.idempotencyExpiresAt)
      : null,
    createdAt: new Date(row.createdAt),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
  };
}

export class TransactionModel {
  private buildListWhere(
    startDate?: string,
    endDate?: string,
    filters: TransactionListFilters = {},
  ): { whereSql: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    const addCondition = (condition: string, value: any) => {
      params.push(value);
      conditions.push(condition.replace("?", `$${params.length}`));
    };

    if (startDate) {
      addCondition("created_at >= ?", new Date(`${startDate}T00:00:00.000Z`));
    }

    if (endDate) {
      addCondition("created_at <= ?", normalizeEndDate(endDate));
    }

    if (filters.minAmount !== undefined && Number.isFinite(filters.minAmount)) {
      addCondition("amount >= ?", filters.minAmount);
    }

    if (filters.maxAmount !== undefined && Number.isFinite(filters.maxAmount)) {
      addCondition("amount <= ?", filters.maxAmount);
    }

    if (filters.provider) {
      addCondition("provider = ?", filters.provider);
    }

    if (filters.referenceNumber) {
      addCondition("reference_number = ?", filters.referenceNumber);
    }

    if (filters.statuses?.length) {
      addCondition("status = ANY(?)", filters.statuses);
    }

    if (filters.tags?.length) {
      addCondition("tags @> ?::text[]", filters.tags);
    }

    return {
      whereSql: conditions.length ? conditions.join(" AND ") : "TRUE",
      params,
    };
  }

  async create(data: any) {
    validateTags(data.tags ?? []);
    const metadata = validateMetadata(data.metadata);
    const ref = await generateReferenceNumber();

    const result = await queryWrite(
      `INSERT INTO transactions (
        reference_number, provider_reference, type, amount, currency,
        original_amount, converted_amount, phone_number, provider,
        stellar_address, status, tags, notes, user_id,
        idempotency_key, idempotency_expires_at, metadata, location_metadata
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
      ) RETURNING *`,
      [
        ref,
        data.providerReference ?? null,
        data.type,
        data.amount,
        data.currency ?? "USD",
        data.originalAmount ?? data.amount,
        data.convertedAmount ?? null,
        encrypt(data.phoneNumber),
        data.provider,
        encrypt(data.stellarAddress), // ✅ FIXED BUG HERE
        data.status,
        data.tags ?? [],
        encrypt(data.notes ?? null),
        data.userId ?? null,
        data.idempotencyKey ?? null,
        data.idempotencyExpiresAt ?? null,
        JSON.stringify(metadata),
        data.locationMetadata ? JSON.stringify(data.locationMetadata) : null,
      ],
    );

    const transaction = mapTransactionRow(result.rows[0]);

    // Invalidate caches after successful transaction creation.
    if (data.userId) {
      await Promise.resolve(
        CachedTransactionInvalidation.invalidateUserCaches(data.userId),
      ).catch((err) => {
        console.warn(
          "[cache] Failed to invalidate user caches on transaction create",
          err,
        );
      });
    }

    if (data.provider) {
      await Promise.resolve(
        CachedTransactionInvalidation.invalidateProviderStats(data.provider),
      ).catch((err) => {
        console.warn(
          "[cache] Failed to invalidate provider stats on transaction create",
          err,
        );
      });
    } else {
      await Promise.resolve(
        CachedTransactionInvalidation.invalidateGeneralStats(),
      ).catch((err) => {
        console.warn(
          "[cache] Failed to invalidate general stats on transaction create",
          err,
        );
      });
    }

    return transaction;
  }

  async findById(id: string, userId?: string) {
    let q = `SELECT ${TRANSACTION_SELECT_COLUMNS} FROM transactions WHERE id=$1`;
    const params: any[] = [id];

    if (userId) {
      q += ` AND user_id=$2`;
      params.push(userId);
    }

    const res = await queryRead(q, params);
    return mapTransactionRow(res.rows[0]);
  }

  async updateStatus(id: string, status: TransactionStatus, userId?: string) {
    let q = `UPDATE transactions SET status=$1, updated_at=NOW() WHERE id=$2`;
    const params: any[] = [status, id];

    if (userId) {
      q += ` AND user_id=$3`;
      params.push(userId);
    }

    q += ` RETURNING user_id, provider, reference_number, updated_at`;

    const res = await queryWrite(q, params);
    if (!res.rowCount) return;

    const row = res.rows[0];

    // ── Invalidate caches on transaction status update ────────────────────
    if (row.user_id) {
      await Promise.resolve(
        CachedTransactionInvalidation.invalidateUserCaches(row.user_id),
      ).catch((err) => {
        console.warn(
          "[cache] Failed to invalidate user caches on transaction status update",
          err,
        );
      });
    }

    if (row.provider) {
      await Promise.resolve(
        CachedTransactionInvalidation.invalidateProviderStats(row.provider),
      ).catch((err) => {
        console.warn(
          "[cache] Failed to invalidate provider stats on transaction update",
          err,
        );
      });
    } else {
      await Promise.resolve(
        CachedTransactionInvalidation.invalidateGeneralStats(),
      ).catch((err) => {
        console.warn(
          "[cache] Failed to invalidate general stats on transaction update",
          err,
        );
      });
    }

    // ── Publish GraphQL subscription event ──────────────────────────────
    // Publish to both the per-transaction channel (targeted) and the
    // broadcast channel (for clients watching all transactions).
    const pubsub = getRedisPubSub();

    const payload: TransactionUpdatedPayload = {
      id,
      referenceNumber: row.reference_number,
      status,
      updatedAt: new Date(row.updated_at).toISOString(),
    };

    await pubsub.publish(transactionChannel(id), payload);
    await pubsub.publish(SubscriptionChannels.TRANSACTION_UPDATED, payload);

    const ws = WebSocketManager.getInstance();
    await ws?.broadcastTransactionUpdate({
      id,
      status,
      userId: row.user_id,
    });
  }

  async searchByNotes(query: string) {
    const res = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE to_tsvector('english', COALESCE(notes,'') || ' ' || COALESCE(admin_notes,'')) 
       @@ plainto_tsquery('english',$1)
       ORDER BY ts_rank(
         to_tsvector('english', COALESCE(notes,'') || ' ' || COALESCE(admin_notes,'')),
         plainto_tsquery('english',$1)
       ) DESC, created_at DESC`,
      [query],
    );

    return res.rows.map(mapTransactionRow);
  }

  async getBalanceStatistics(userId: string) {
    const res = await queryRead(
      `SELECT 
        COALESCE(SUM(t.amount) FILTER (WHERE t.type='deposit' AND t.status='completed'),0)::text as total_deposited,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type='withdraw' AND t.status IN ('completed', 'pending')),0)::text as total_withdrawn,
        (COALESCE(SUM(t.amount) FILTER (WHERE t.type='deposit' AND t.status='completed'),0) -
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='withdraw' AND t.status IN ('completed', 'pending')),0))::text as current_balance,
        (COALESCE(SUM(t.amount) FILTER (WHERE t.type='deposit' AND t.status='completed' AND t.created_at + (u.settlement_delay_days || ' days')::interval <= CURRENT_TIMESTAMP),0) -
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='withdraw' AND t.status IN ('completed', 'pending')),0))::text as available_balance,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type='deposit' AND t.status='completed' AND t.created_at + (u.settlement_delay_days || ' days')::interval > CURRENT_TIMESTAMP),0)::text as pending_balance
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.user_id=$1`,
      [userId]
    );

    return res.rows[0];
  }

  async findCompletedByUserSince(
    userId: string,
    since: Date,
  ): Promise<Transaction[]> {
    const query = `
      SELECT ${TRANSACTION_SELECT_COLUMNS}
      FROM transactions
      WHERE user_id = $1
        AND status = 'completed'
        AND created_at >= $2
      ORDER BY created_at DESC
    `;

    const result = await queryRead(query, [userId, since]);
    return result.rows.map(mapTransactionRow);
  }

  async list(
    limit = 50,
    offset = 0,
    startDate?: string,
    endDate?: string,
    filters: TransactionListFilters = {},
    cursorOptions: TransactionCursorOptions = {},
  ): Promise<Transaction[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 1000);
    const safeOffset = Math.max(offset, 0);
    const { before, after } = cursorOptions;

    if (before && after) {
      throw new Error("Use either before or after cursor, not both");
    }

    const { whereSql, params } = this.buildListWhere(
      startDate,
      endDate,
      filters,
    );

    if (after || before) {
      const cursor = decodeTransactionCursor((after || before) as string);
      const comparator = after ? "<" : ">";
      const direction = after ? "DESC" : "ASC";
      const cursorCreatedAtParam = params.length + 1;
      const cursorIdParam = params.length + 2;
      const limitParam = params.length + 3;

      const result = await queryRead(
        `SELECT ${TRANSACTION_SELECT_COLUMNS}
         FROM transactions
         WHERE ${whereSql}
           AND (created_at, id) ${comparator} ($${cursorCreatedAtParam}, $${cursorIdParam})
         ORDER BY created_at ${direction}, id ${direction}
         LIMIT $${limitParam}`,
        [...params, cursor.createdAt, cursor.id, cappedLimit],
      );

      return result.rows.map(mapTransactionRow);
    }

    if (safeOffset > 0) {
      const anchorOffsetParam = params.length + 1;
      const limitParam = params.length + 2;

      const result = await queryRead(
        `WITH anchor AS (
           SELECT created_at, id
           FROM transactions
           WHERE ${whereSql}
           ORDER BY created_at DESC, id DESC
           LIMIT 1 OFFSET $${anchorOffsetParam}
         )
         SELECT ${TRANSACTION_SELECT_COLUMNS}
         FROM transactions
         WHERE ${whereSql}
           AND EXISTS (SELECT 1 FROM anchor)
           AND (created_at, id) < (SELECT created_at, id FROM anchor)
         ORDER BY created_at DESC, id DESC
         LIMIT $${limitParam}`,
        [...params, safeOffset - 1, cappedLimit],
      );

      return result.rows.map(mapTransactionRow);
    }

    const limitParam = params.length + 1;
    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParam}`,
      [...params, cappedLimit],
    );

    return result.rows.map(mapTransactionRow);
  }

  async count(
    startDate?: string,
    endDate?: string,
    filters: TransactionListFilters = {},
  ): Promise<number> {
    const { whereSql, params } = this.buildListWhere(
      startDate,
      endDate,
      filters,
    );

    const result = await queryRead(
      `SELECT COUNT(*)::int AS total
       FROM transactions
       WHERE ${whereSql}`,
      params,
    );

    return Number(result.rows[0]?.total ?? 0);
  }

  async findByStatuses(
    statuses: TransactionStatus[] = [],
    limit = 50,
    offset = 0,
  ): Promise<Transaction[]> {
    return this.list(limit, offset, undefined, undefined, { statuses });
  }

  async countByStatuses(statuses: TransactionStatus[] = []): Promise<number> {
    return this.count(undefined, undefined, { statuses });
  }

  async findByUserId(userId: string): Promise<Transaction[]> {
    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE user_id = $1`,
      [userId],
    );

    return result.rows.map(mapTransactionRow).filter((t: any) => t !== null);
  }

  async findByReferenceNumber(
    referenceNumber: string,
  ): Promise<Transaction | null> {
    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE reference_number = $1`,
      [referenceNumber],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async findByTags(tags: string[]): Promise<Transaction[]> {
    validateTags(tags);

    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE tags @> $1
       ORDER BY created_at DESC`,
      [tags],
    );

    return result.rows.map(mapTransactionRow).filter((t: any) => t !== null);
  }

  async addTags(id: string, tags: string[]): Promise<Transaction | null> {
    validateTags(tags);

    const result = await queryWrite(
      `UPDATE transactions
       SET tags = (
         SELECT ARRAY(SELECT DISTINCT unnest(tags || $1::TEXT[]))
         FROM transactions
         WHERE id = $2
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND cardinality(
           ARRAY(SELECT DISTINCT unnest(tags || $1::TEXT[]))
         ) <= ${MAX_TAGS}
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [tags, id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async removeTags(id: string, tags: string[]): Promise<Transaction | null> {
    const result = await queryWrite(
      `UPDATE transactions
       SET tags = ARRAY(
         SELECT unnest(tags)
         EXCEPT
         SELECT unnest($1::TEXT[])
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [tags, id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async incrementRetryCount(id: string): Promise<number> {
    const result = await queryWrite<{ retry_count: number }>(
      `UPDATE transactions
       SET retry_count = COALESCE(retry_count, 0) + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING retry_count`,
      [id],
    );

    return result.rows[0]?.retry_count ?? 0;
  }

  async updateNotes(id: string, notes: string): Promise<Transaction | null> {
    if (notes.length > 1000) {
      throw new Error("Notes cannot exceed 1000 characters");
    }

    const encryptedNotes = encrypt(notes);
    const result = await queryWrite(
      `UPDATE transactions
       SET notes = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [encryptedNotes, id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async updateAdminNotes(
    id: string,
    adminNotes: string,
  ): Promise<Transaction | null> {
    if (adminNotes.length > 1000) {
      throw new Error("Admin notes cannot exceed 1000 characters");
    }

    const encryptedAdminNotes = encrypt(adminNotes);
    const result = await queryWrite(
      `UPDATE transactions
       SET admin_notes = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [encryptedAdminNotes, id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<Transaction | null> {
    const validated = validateMetadata(metadata);

    const result = await queryWrite(
      `UPDATE transactions
       SET metadata = $1::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [JSON.stringify(validated), id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async patchMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Transaction | null> {
    validateMetadata(patch);

    const result = await queryWrite(
      `UPDATE transactions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [JSON.stringify(patch), id],
    );

    const row = mapTransactionRow(result.rows[0]);
    if (row) {
      const combinedSize = Buffer.byteLength(
        JSON.stringify(row.metadata),
        "utf8",
      );
      if (combinedSize > MAX_METADATA_BYTES) {
        const keys = Object.keys(patch);
        await queryWrite(
          `UPDATE transactions
           SET metadata = metadata - $1::text[],
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [keys, id],
        );
        throw new Error(
          `Metadata exceeds maximum size of ${MAX_METADATA_BYTES / 1024} KB`,
        );
      }
    }

    return row;
  }

  async removeMetadataKeys(
    id: string,
    keys: string[],
  ): Promise<Transaction | null> {
    if (!keys.length) return this.findById(id);

    const result = await queryWrite(
      `UPDATE transactions
       SET metadata = metadata - $1::text[],
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [keys, id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async findByMetadata(
    filter: Record<string, unknown>,
  ): Promise<Transaction[]> {
    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE metadata @> $1::jsonb
       ORDER BY created_at DESC`,
      [JSON.stringify(filter)],
    );

    return result.rows.map(mapTransactionRow).filter((t: any) => t !== null);
  }

  async searchByPhoneNumber(
    phoneNumber: string,
    limit = 50,
    offset = 0,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const off = Math.max(offset, 0);

    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [capped, off],
    );

    const mapped = result.rows
      .map((r: any) => mapTransactionRow(r))
      .filter((t: any): t is Transaction => t !== null)
      .filter((t: any) => t.phoneNumber.includes(phoneNumber));

    const total = mapped.length;

    return { transactions: mapped, total };
  }

  async releaseAllExpiredIdempotencyKeys(): Promise<number> {
    const result = await queryWrite<{ released: number }>(
      `WITH updated AS (
          UPDATE transactions
          SET idempotency_key = NULL,
              idempotency_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key IS NOT NULL
            AND idempotency_expires_at IS NOT NULL
            AND idempotency_expires_at <= CURRENT_TIMESTAMP
          RETURNING 1
        )
        SELECT COUNT(*)::int AS released FROM updated`,
    );

    return result?.rows?.[0]?.released || 0;
  }

  async releaseExpiredIdempotencyKey(idempotencyKey: string): Promise<void> {
    await queryWrite(
      `UPDATE transactions
       SET idempotency_key = NULL,
           idempotency_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE idempotency_key = $1
         AND idempotency_expires_at IS NOT NULL
         AND idempotency_expires_at <= CURRENT_TIMESTAMP`,
      [idempotencyKey],
    );
  }

  async findActiveByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE idempotency_key = $1
         AND (
           idempotency_expires_at IS NULL
           OR idempotency_expires_at > CURRENT_TIMESTAMP
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [idempotencyKey],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async findByStatusAndProvider(
    status: TransactionStatus,
    provider: string,
    type: "deposit" | "withdraw",
    limit = 50,
  ): Promise<Transaction[]> {
    const capped = Math.min(Math.max(limit, 1), 50);

    const result = await queryRead(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE status = $1
          AND provider = $2
          AND type = $3
        ORDER BY created_at ASC
        LIMIT $4`,
      [status, provider.toLowerCase(), type, capped],
    );

    return result.rows.map(mapTransactionRow).filter((t: any) => t !== null);
  }

  async updateWebhookDelivery(
    id: string,
    delivery: WebhookDeliveryUpdate,
  ): Promise<void> {
    await queryWrite(
      `UPDATE transactions
       SET webhook_delivery_status = $1,
           webhook_last_attempt_at = $2,
           webhook_delivered_at = $3,
           webhook_last_error = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        delivery.status,
        delivery.lastAttemptAt ?? null,
        delivery.deliveredAt ?? null,
        delivery.lastError ?? null,
        id,
      ],
    );
  }
}
