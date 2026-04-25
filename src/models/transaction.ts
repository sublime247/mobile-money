import { pool, queryRead, queryWrite } from "../config/database";
import { generateReferenceNumber } from "../utils/referenceGenerator";
import { encrypt, decrypt } from "../utils/encryption";
import { WebSocketManager } from "../websocket";
import { getRedisPubSub } from "../graphql/redisPubSub";
import {
  SubscriptionChannels,
  transactionChannel,
  type TransactionUpdatedPayload,
} from "../graphql/subscriptions";

export type AssetType = 'native' | 'credit_alphanum4' | 'credit_alphanum12';
export enum TransactionStatus {
  Pending = "pending",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Review = "review",
}

const MAX_TAGS = 10;
const TAG_REGEX = /^[a-z0-9-]+$/;

const MAX_METADATA_BYTES = 10240; // 10 KB
const MAX_NOTES_LENGTH = 256;

const TRANSACTION_SELECT_COLUMNS = `
  id,
  reference_number AS "referenceNumber",
  provider_reference AS "providerReference",
  type,
  amount::text AS amount,
  phone_number AS "phoneNumber",
  provider,
  provider_reference AS "providerReference",
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
  if (tags.length > MAX_TAGS) {
    throw new Error(`Maximum ${MAX_TAGS} tags allowed`);
  }

  for (const tag of tags) {
    if (!TAG_REGEX.test(tag)) {
      throw new Error(`Invalid tag format: "${tag}"`);
    }
  }
}

function validateMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null || metadata === undefined) {
    return {};
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Metadata must be a JSON object");
  }

  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new Error(
      `Metadata exceeds maximum size of ${MAX_METADATA_BYTES / 1024} KB`,
    );
  }

  return metadata as Record<string, unknown>;
}

export interface Transaction {
  id: string;
  referenceNumber: string;
  providerReference?: string | null;
  type: "deposit" | "withdraw";
  amount: string;
  /** ISO 4217 currency code of the original transaction amount (default: USD). */
  currency?: string;
  /** Amount in the original currency (mirrors `amount`). */
  originalAmount?: string;
  /** Amount converted to the base currency (USD) for uniform aggregation. */
  convertedAmount?: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  status: TransactionStatus;
  // NEW fields
  assetType: AssetType;
  assetCode?: string;   // e.g. 'USDC' — only for anchored assets
  assetIssuer?: string; // issuer address — only for anchored assets
  tags: string[];
  notes?: string;
  adminNotes?: string;
  admin_notes?: string;
  userId?: string | null;
  idempotencyKey?: string | null;
  idempotencyExpiresAt?: Date | null;
  retryCount?: number;
  webhook_delivery_status?: "pending" | "delivered" | "failed" | "skipped";
  webhook_last_attempt_at?: Date | null;
  webhook_delivered_at?: Date | null;
  webhook_last_error?: string | null;
  metadata?: Record<string, unknown>;
  /** Geolocation metadata captured at transaction creation time. */
  locationMetadata?: {
    country: string;
    countryCode: string;
    city: string;
    isp: string;
    status: "resolved" | "unknown" | "pending";
  } | null;

  createdAt: Date;
  updatedAt?: Date | null;
}

export interface CreateTransactionInput {
  type: Transaction["type"];
  amount: string | number;
  phoneNumber: string;
  provider: string;
  providerReference?: string | null;
  stellarAddress: string;
  status: TransactionStatus;
  tags?: string[];
  notes?: string | null;
  userId?: string | null;
  idempotencyKey?: string | null;
  idempotencyExpiresAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  currency?: string;
  originalAmount?: string;
  convertedAmount?: string;
  locationMetadata?: {
    country: string;
    countryCode: string;
    city: string;
    isp: string;
    status: "resolved" | "unknown" | "pending";
  } | null;
}

export interface WebhookDeliveryUpdate {
  status: "pending" | "delivered" | "failed" | "skipped";
  lastAttemptAt?: Date | null;
  deliveredAt?: Date | null;
  lastError?: string | null;
}

/** Map a pg row (snake_case) to the Transaction interface */
export function mapTransactionRow(
  row: Record<string, unknown> | Transaction | undefined | null,
): Transaction | null {
  if (!row) return null;
  const dbRow = row as Record<string, unknown>;
  const created = dbRow.created_at ?? row.createdAt;
  const updated = dbRow.updated_at ?? row.updatedAt;

  // Cast to any for easier access to snake_case fields that might be in the object
  const r = row as any;
  const db = dbRow as any;

  return {
    id: String(r.id),
    referenceNumber: String(db.reference_number ?? r.referenceNumber ?? ""),
    type: (r.type as Transaction["type"]) || "deposit",
    amount: String(r.amount ?? ""),
    phoneNumber: decrypt(
      String(db.phone_number ?? r.phoneNumber ?? ""),
    ) as string,
    provider: String(r.provider ?? ""),
    stellarAddress: decrypt(
      String(db.stellar_address ?? r.stellarAddress ?? ""),
    ) as string,
    status: r.status as TransactionStatus,
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    notes: decrypt(db.notes ?? r.notes) ?? undefined,
    admin_notes:
      decrypt(db.admin_notes ?? r.admin_notes ?? r.adminNotes) ?? undefined,
    metadata:
      r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
        ? (r.metadata as Record<string, unknown>)
        : {},
    locationMetadata:
      r.locationMetadata &&
      typeof r.locationMetadata === "object" &&
      !Array.isArray(r.locationMetadata)
        ? (r.locationMetadata as Transaction["locationMetadata"])
        : null,
    userId:
      db.user_id != null || r.userId != null
        ? String(db.user_id ?? r.userId)
        : null,
    retryCount: Number(db.retry_count ?? r.retryCount ?? 0),
    // Add missing required properties with defaults
    assetType: (r.asset_type ?? r.assetType ?? 'native') as AssetType,
    assetCode: r.asset_code ?? r.assetCode ?? undefined,
    assetIssuer: r.asset_issuer ?? r.assetIssuer ?? undefined,
    currency: r.currency ?? 'USD',
    originalAmount: r.original_amount ?? r.originalAmount ?? r.amount,
    convertedAmount: r.converted_amount ?? r.convertedAmount ?? undefined,
    idempotencyKey: r.idempotency_key ?? r.idempotencyKey ?? undefined,
    idempotencyExpiresAt: r.idempotency_expires_at ?? r.idempotencyExpiresAt ? new Date(String(r.idempotency_expires_at ?? r.idempotencyExpiresAt)) : undefined,
    webhook_delivery_status: r.webhook_delivery_status ?? undefined,
    webhook_last_attempt_at: r.webhook_last_attempt_at ? new Date(String(r.webhook_last_attempt_at)) : undefined,
    webhook_delivered_at: r.webhook_delivered_at ? new Date(String(r.webhook_delivered_at)) : undefined,
    webhook_last_error: r.webhook_last_error ?? undefined,
    createdAt:
      created instanceof Date ? created : new Date(String(created ?? "")),
    updatedAt:
      updated instanceof Date
        ? updated
        : updated
          ? new Date(String(updated))
          : null,
  };
}

export class TransactionModel {
  async create(data: CreateTransactionInput): Promise<Transaction> {
    const tags = data.tags ?? [];
    validateTags(tags);
    const metadata = validateMetadata(data.metadata);
    const referenceNumber = await generateReferenceNumber();

    const result = await queryWrite(
      `INSERT INTO transactions (
           reference_number, provider_reference, type, amount, currency, original_amount, 
           converted_amount, phone_number, provider, stellar_address, 
           status, tags, notes, user_id, idempotency_key, 
           idempotency_expires_at, metadata, location_metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *`,
      [
        referenceNumber,
        data.providerReference ?? null,
        data.type,
        data.amount,
        data.currency ?? "USD",
        data.originalAmount ?? data.amount,
        data.convertedAmount ?? null,
        encrypt(data.phoneNumber),
        data.provider,
        data.providerReference ?? null,
        encrypt(data.stellarAddress),
        data.status,
        tags,
        encrypt(data.notes ?? null),
        data.userId ?? null,
        data.idempotencyKey ?? null,
        data.idempotencyExpiresAt ?? null,
        JSON.stringify(metadata),
        data.locationMetadata ? JSON.stringify(data.locationMetadata) : null,
      ],
    );

    return mapTransactionRow(result.rows[0])!;
  }

  async findByUserId(userId: string): Promise<Transaction[]> {
    const result = await pool.query<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE user_id = $1`,
      [userId],
    );

    return result.rows;
  }

  async findById(id: string): Promise<Transaction | null> {
    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE id = $1`,
      [id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  /** Paginated list, newest first. `limit` is capped at 100.
   * Updated for Issue #243: Advanced Filtering
   */
  async list(
    limit = 50,
    offset = 0,
    startDate?: string,
    endDate?: string,
    filters?: {
      minAmount?: number;
      maxAmount?: number;
      provider?: string;
      providerReference?: string;
      referenceNumber?: string;
      tags?: string[];
    },
  ) {
    const capped = Math.min(Math.max(limit, 1), 100);
    const off = Math.max(offset, 0);

    let query = "SELECT * FROM transactions WHERE 1=1";
    const params: unknown[] = [];
    let p = 1;

    if (startDate) {
      query += " AND created_at >= $" + p++;
      params.push(new Date(startDate).toISOString());
    }
    if (endDate) {
      query += " AND created_at <= $" + p++;
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      params.push(end.toISOString());
    }
    if (filters?.minAmount !== undefined) {
      query += " AND amount >= $" + p++;
      params.push(filters.minAmount);
    }
    if (filters?.maxAmount !== undefined) {
      query += " AND amount <= $" + p++;
      params.push(filters.maxAmount);
    }
    if (filters?.provider) {
      query += " AND provider = $" + p++;
      params.push(filters.provider.toLowerCase());
    }
    if (filters?.providerReference) {
      query += " AND provider_reference = $" + p++;
      params.push(filters.providerReference);
    }
    if (filters?.referenceNumber) {
      query += " AND reference_number = $" + p++;
      params.push(filters.referenceNumber);
    }
    if (filters?.tags && filters.tags.length > 0) {
      query += " AND tags @> $" + p++ + "::text[]";
      params.push(filters.tags);
    }

    query += " ORDER BY created_at DESC LIMIT $" + p++ + " OFFSET $" + p++;
    params.push(capped, off);

    const result = await queryRead(query, params);
    return result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null);
  }

  /** Count matching rows — mirrors the filters in list(). */
  async count(
    startDate?: string,
    endDate?: string,
    filters?: {
      minAmount?: number;
      maxAmount?: number;
      provider?: string;
      providerReference?: string;
      referenceNumber?: string;
      tags?: string[];
    },
  ): Promise<number> {
    let query = "SELECT COUNT(*) FROM transactions WHERE 1=1";
    const params: unknown[] = [];
    let p = 1;

    if (startDate) {
      query += " AND created_at >= $" + p++;
      params.push(new Date(startDate).toISOString());
    }
    if (endDate) {
      query += " AND created_at <= $" + p++;
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      params.push(end.toISOString());
    }
    if (filters?.minAmount !== undefined) {
      query += " AND amount >= $" + p++;
      params.push(filters.minAmount);
    }
    if (filters?.maxAmount !== undefined) {
      query += " AND amount <= $" + p++;
      params.push(filters.maxAmount);
    }
    if (filters?.provider) {
      query += " AND provider = $" + p++;
      params.push(filters.provider.toLowerCase());
    }
    if (filters?.providerReference) {
      query += " AND provider_reference = $" + p++;
      params.push(filters.providerReference);
    }
    if (filters?.referenceNumber) {
      query += " AND reference_number = $" + p++;
      params.push(filters.referenceNumber);
    }
    if (filters?.tags && filters.tags.length > 0) {
      query += " AND tags @> $" + p++ + "::text[]";
      params.push(filters.tags);
    }

    const result = await queryRead(query, params);
    return parseInt(result.rows[0].count);
  }

  async updateStatus(id: string, status: TransactionStatus): Promise<void> {
    const result = await queryWrite<{ user_id: string | null; reference_number: string; updated_at: Date }>(
      `UPDATE transactions
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING user_id, reference_number, updated_at`,
      [status, id],
    );

    if (result.rowCount === 0) {
      return;
    }

    const row = result.rows[0];

    // ── Publish GraphQL subscription event ──────────────────────────────
    // Publish to both the per-transaction channel (targeted) and the
    // broadcast channel (for clients watching all transactions).
    const pubsub = getRedisPubSub();
    const now = row.updated_at?.toISOString() ?? new Date().toISOString();

    const payload: TransactionUpdatedPayload = {
      id,
      referenceNumber: row.reference_number,
      status,
      updatedAt: now,
    };

    // Per-transaction channel — clients subscribed to transactionUpdated(id: $id)
    pubsub.publish(transactionChannel(id), payload).catch((err) => {
      console.error(`[pubsub] Failed to publish ${transactionChannel(id)}`, err);
    });

    // Broadcast channels for status-specific subscriptions
    if (status === TransactionStatus.Completed) {
      pubsub.publish(SubscriptionChannels.TRANSACTION_COMPLETED, payload).catch(() => {});
    } else if (status === TransactionStatus.Failed) {
      pubsub.publish(SubscriptionChannels.TRANSACTION_FAILED, payload).catch(() => {});
    }

    // Generic updated broadcast
    pubsub.publish(SubscriptionChannels.TRANSACTION_UPDATED, payload).catch(() => {});

    // ── WebSocket broadcast (existing behaviour) ─────────────────────────
    const wsManager = WebSocketManager.getInstance();
    if (!wsManager) {
      return;
    }

    try {
      await wsManager.broadcastTransactionUpdate({
        id,
        status,
        userId: row.user_id ?? null,
      });
    } catch (error) {
      console.error(
        `[websocket] Failed to broadcast transaction status update for ${id}`,
        error,
      );
    }
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

  async findByReferenceNumber(
    referenceNumber: string,
  ): Promise<Transaction | null> {
    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE reference_number = $1`,
      [referenceNumber],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async findByTags(tags: string[]): Promise<Transaction[]> {
    validateTags(tags);

    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE tags @> $1
        ORDER BY created_at DESC`,
      [tags],
    );

    return result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null);
  }

  async addTags(id: string, tags: string[]): Promise<Transaction | null> {
    validateTags(tags);

    const result = await queryWrite<Transaction>(
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
    const result = await queryWrite<Transaction>(
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

  async findCompletedByUserSince(
    userId: string,
    since: Date,
  ): Promise<Transaction[]> {
    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE user_id = $1
          AND status = 'completed'
          AND created_at >= $2
        ORDER BY created_at DESC`,
      [userId, since],
    );
    return result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null);
  }

  /** Increments retry_count after a failed transient attempt (before the next try). */
  async incrementRetryCount(id: string): Promise<number> {
    const result = await queryWrite(
      `UPDATE transactions
        SET retry_count = retry_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING retry_count`,
      [id],
    );

    return Number(result.rows[0]?.retry_count ?? 0);
  }

  async updateNotes(id: string, notes: string): Promise<Transaction | null> {
    if (notes.length > MAX_NOTES_LENGTH) {
      throw new Error(`Notes cannot exceed ${MAX_NOTES_LENGTH} characters`);
    }

    const encryptedNotes = encrypt(notes);
    const result = await queryWrite<Transaction>(
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
    const result = await queryWrite<Transaction>(
      `UPDATE transactions
        SET admin_notes = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [encryptedAdminNotes, id],
    );

    return mapTransactionRow(result.rows[0]);
  }

  async searchByNotes(query: string): Promise<Transaction[]> {
    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE to_tsvector(
          'english',
          COALESCE(notes, '') || ' ' || COALESCE(admin_notes, '')
        ) @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank(
          to_tsvector('english', COALESCE(notes, '') || ' ' || COALESCE(admin_notes, '')),
          plainto_tsquery('english', $1)
        ) DESC, created_at DESC`,
      [query],
    );

    return result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null);
  }

  // ── Metadata (JSONB) ────────────────────────────────────────────────────

  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<Transaction | null> {
    const validated = validateMetadata(metadata);

    const result = await queryWrite<Transaction>(
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

    const result = await queryWrite<Transaction>(
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

    const result = await queryWrite<Transaction>(
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
    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE metadata @> $1::jsonb
        ORDER BY created_at DESC`,
      [JSON.stringify(filter)],
    );

    return result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null);
  }

  async searchByPhoneNumber(
    phoneNumber: string,
    limit = 50,
    offset = 0,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const off = Math.max(offset, 0);

    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [capped, off],
    );

    const mapped = result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null)
      .filter((t) => t.phoneNumber.includes(phoneNumber));

    const total = mapped.length; // This is only total for this page

    return { transactions: mapped, total };
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

  async findActiveByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    const result = await queryRead<Transaction>(
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

  async countByStatuses(statuses: TransactionStatus[]): Promise<number> {
    const validStatuses =
      statuses.length > 0 ? statuses : Object.values(TransactionStatus);
    const result = await queryRead<{ total: number }>(
      `SELECT COUNT(*)::int AS total
        FROM transactions
        WHERE status = ANY($1::text[])`,
      [validStatuses],
    );

    return result.rows[0]?.total ?? 0;
  }

  async findByStatuses(
    statuses: TransactionStatus[],
    limit = 50,
    offset = 0,
  ): Promise<Transaction[]> {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const off = Math.max(offset, 0);
    const validStatuses =
      statuses.length > 0 ? statuses : Object.values(TransactionStatus);

    const result = await queryRead<Transaction>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE status = ANY($1::text[])
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [validStatuses, capped, off],
    );

    return result.rows
      .map((r) => mapTransactionRow(r))
      .filter((t): t is Transaction => t !== null);
  }
}
