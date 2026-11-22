import { queryRead, queryWrite } from "../config/database";
import { generateReferenceNumber } from "../utils/referenceGenerator";
import { encrypt, decrypt } from "../utils/encryption";
import { WebSocketManager } from "../websocket";
import { getRedisPubSub } from "../graphql/redisPubSub";
import { CachedTransactionInvalidation } from "../services/cachedTransactionService";
import { publishTransactionEvent } from "../services/transactionEventStream";
import {
  SubscriptionChannels,
  transactionChannel,
  type TransactionUpdatedPayload,
} from "../graphql/subscriptions";

export type AssetType = "native" | "credit_alphanum4" | "credit_alphanum12";

export enum TransactionStatus {
  Pending = "pending",
  Processing = "processing",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Review = "review",
  /**
   * Held before provider dispatch by AML velocity monitoring until a
   * compliance officer releases (back to Pending) or rejects (Cancelled) it.
   */
  PendingReview = "pending_review",
  Dispute = "dispute",
  Reversed = "reversed",
  ClawedBack = "clawed_back",
  /**
   * A deposit/withdrawal that timed out waiting on an external party (the
   * mobile money provider, or an anchor's SEP-24 interactive flow) without
   * ever reaching a terminal completed/failed state at the source. Distinct
   * from `Failed`: a failure means the provider/anchor actively rejected or
   * errored the transaction; `Expired` means it never got an answer at all.
   * See staleTransactionWatchdog.ts (#1793) — a stuck transaction whose
   * provider status check comes back "pending"/"unknown" (not an actual
   * failure report) is expired, not failed.
   */
  Expired = "expired",
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
  providerReference?: string;
  stellarAddress?: string | null;
  tags?: string[];
  notes?: string;
  adminNotes?: string;
  metadata?: Record<string, unknown> | null;
  locationMetadata?: Record<string, unknown> | null;
  assetType?: AssetType;
  assetCode?: string | null;
  assetIssuer?: string | null;
  currency?: string;
  originalAmount?: string;
  convertedAmount?: string | null;
  idempotencyKey?: string | null;
  idempotencyExpiresAt?: Date | null;
}

export interface TransactionListFilters {
  userId?: string;
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

/**
 * Raw row shape returned by TRANSACTION_SELECT_COLUMNS queries.
 * All amounts are cast to ::text in SQL so they arrive as strings.
 */
export interface TransactionRow {
  id: string;
  referenceNumber: string;
  providerReference?: string | null;
  type: string;
  amount: string;
  phoneNumber: string | null;
  provider: string;
  stellarAddress: string | null;
  // The DB column is text; rows arriving from other queries may carry a
  // plain string, so the domain mapping normalizes it to TransactionStatus.
  status: TransactionStatus | string;
  tags?: string[] | null;
  notes?: string | null;
  adminNotes?: string | null;
  metadata?: Record<string, unknown> | null;
  locationMetadata?: Record<string, unknown> | null;
  userId?: string | null;
  assetType?: AssetType | null;
  assetCode?: string | null;
  assetIssuer?: string | null;
  currency?: string | null;
  originalAmount?: string | null;
  convertedAmount?: string | null;
  idempotencyKey?: string | null;
  idempotencyExpiresAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
}

export function mapTransactionRow(
  row: TransactionRow | null | undefined,
): Transaction | null {
  if (!row) return null;

  return {
    id: String(row.id),
    referenceNumber: row.referenceNumber,
    type: row.type,
    amount: String(row.amount),
    phoneNumber: decrypt(row.phoneNumber),
    provider: row.provider,
    stellarAddress: decrypt(row.stellarAddress),
    status: row.status as TransactionStatus,
    tags: row.tags ?? [],
    notes: decrypt(row.notes ?? null) ?? undefined,
    adminNotes: decrypt(row.adminNotes ?? null) ?? undefined,
    metadata: row.metadata ?? {},
    locationMetadata: row.locationMetadata ?? null,
    userId: row.userId ?? "",
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

export interface CreateTransactionData {
  type: string;
  amount: string | number;
  phoneNumber?: string | null;
  provider: string;
  stellarAddress?: string | null;
  status?: TransactionStatus | string;
  tags?: string[];
  notes?: string;
  userId?: string | null;
  providerReference?: string;
  currency?: string;
  originalAmount?: string | number;
  convertedAmount?: string | number;
  idempotencyKey?: string;
  idempotencyExpiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  locationMetadata?: Record<string, unknown> | null;
}

export interface BalanceStatisticsRow {
  total_deposited: string;
  total_withdrawn: string;
  current_balance: string;
  available_balance: string;
  pending_balance: string;
}

export interface StatusUpdateRow {
  user_id?: string | null;
  provider?: string | null;
  reference_number?: string | null;
  updated_at?: Date | string | null;
}

export const ALLOWED_STATUS_TRANSITIONS: Record<
  TransactionStatus,
  TransactionStatus[]
> = {
  [TransactionStatus.Pending]: [
    TransactionStatus.Pending,
    TransactionStatus.Processing,
    TransactionStatus.Completed,
    TransactionStatus.Failed,
    TransactionStatus.Cancelled,
    TransactionStatus.Review,
    TransactionStatus.PendingReview,
    TransactionStatus.Expired,
  ],
  [TransactionStatus.PendingReview]: [
    TransactionStatus.PendingReview,
    TransactionStatus.Pending,
    TransactionStatus.Cancelled,
    TransactionStatus.Failed,
  ],
  [TransactionStatus.Processing]: [
    TransactionStatus.Processing,
    TransactionStatus.Completed,
    TransactionStatus.Failed,
    TransactionStatus.Cancelled,
    TransactionStatus.Review,
    TransactionStatus.Pending,
    TransactionStatus.Expired,
  ],
  [TransactionStatus.Review]: [
    TransactionStatus.Review,
    TransactionStatus.Processing,
    TransactionStatus.Completed,
    TransactionStatus.Failed,
    TransactionStatus.Cancelled,
  ],
  [TransactionStatus.Completed]: [
    TransactionStatus.Completed,
    TransactionStatus.Dispute,
    TransactionStatus.Reversed,
    TransactionStatus.ClawedBack,
  ],
  [TransactionStatus.Failed]: [
    TransactionStatus.Failed,
    TransactionStatus.Review,
  ],
  [TransactionStatus.Cancelled]: [TransactionStatus.Cancelled],
  [TransactionStatus.Dispute]: [
    TransactionStatus.Dispute,
    TransactionStatus.Completed,
    TransactionStatus.Reversed,
    TransactionStatus.ClawedBack,
    TransactionStatus.Failed,
  ],
  [TransactionStatus.Reversed]: [TransactionStatus.Reversed],
  [TransactionStatus.ClawedBack]: [TransactionStatus.ClawedBack],
  [TransactionStatus.Expired]: [
    TransactionStatus.Expired,
    TransactionStatus.Failed,
  ],
};

export class TransactionModel {
  private buildListWhere(
    startDate?: string,
    endDate?: string,
    filters: TransactionListFilters = {},
  ): { whereSql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const addCondition = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replace("?", `$${params.length}`));
    };

    if (filters.userId) {
      addCondition("user_id = ?", filters.userId);
    }

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

    if (
      filters.referenceNumber &&
      typeof filters.referenceNumber === "string" &&
      filters.referenceNumber.trim()
    ) {
      addCondition("reference_number = ?", filters.referenceNumber.trim());
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

  async create(data: CreateTransactionData): Promise<Transaction | null> {
    validateTags(data.tags ?? []);
    const metadata = validateMetadata(data.metadata);
    const ref = await generateReferenceNumber();

    const result = await queryWrite<TransactionRow>(
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
        data.phoneNumber ? encrypt(data.phoneNumber) : null,
        data.provider,
        data.stellarAddress ? encrypt(data.stellarAddress) : null,
        data.status ?? TransactionStatus.Pending,
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

    // Initial status event for SSE subscribers watching the transaction.
    publishTransactionEvent({
      transactionId: transaction.id,
      userId: data.userId ?? undefined,
      status: transaction.status,
      timestamp: new Date(transaction.createdAt).getTime(),
    });

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

  async findById(id: string, userId?: string): Promise<Transaction | null> {
    let q = `SELECT ${TRANSACTION_SELECT_COLUMNS} FROM transactions WHERE id=$1`;
    const params: (string | number | Date)[] = [id];

    if (userId) {
      q += ` AND user_id=$2`;
      params.push(userId);
    }

    const res = await queryRead<TransactionRow>(q, params);
    return mapTransactionRow(res.rows[0]);
  }

  /**
   * Fetch multiple transactions by ID in a single query, for callers
   * reconciling a batch of transactions (e.g. `POST
   * /transactions/batch-status`) without issuing one round trip per ID.
   * IDs with no matching transaction are simply absent from the result —
   * callers that need a per-ID outcome diff the input against the result.
   */
  async findByIds(ids: string[], userId?: string): Promise<Transaction[]> {
    if (!ids.length) return [];

    let q = `SELECT ${TRANSACTION_SELECT_COLUMNS} FROM transactions WHERE id = ANY($1)`;
    const params: (string[] | string)[] = [ids];

    if (userId) {
      q += ` AND user_id=$2`;
      params.push(userId);
    }

    const res = await queryRead<TransactionRow>(q, params);
    return res.rows.map(mapTransactionRow).filter((t): t is Transaction => t !== null);
  }

  async updateStatus(
    id: string,
    status: TransactionStatus,
    userId?: string,
    expectedPreviousStatuses?: TransactionStatus[],
  ): Promise<boolean> {
    const validPreviousStatuses =
      expectedPreviousStatuses ??
      (Object.keys(ALLOWED_STATUS_TRANSITIONS) as TransactionStatus[]).filter(
        (prev) => ALLOWED_STATUS_TRANSITIONS[prev]?.includes(status),
      );

    let q = `UPDATE transactions SET status=$1, updated_at=NOW() WHERE id=$2 AND (status = $1 OR status = ANY($3::varchar[]))`;
    const params: (string | TransactionStatus | TransactionStatus[])[] = [
      status,
      id,
      validPreviousStatuses,
    ];

    if (userId) {
      q += ` AND user_id=$4`;
      params.push(userId);
    }

    q += ` RETURNING user_id, provider, reference_number, updated_at`;

    const res = await queryWrite<StatusUpdateRow>(q, params);
    if (!res.rowCount) return false;

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

    // ── Publish to the SSE transaction stream ───────────────────────────
    // Buffered in the replay ring buffer so clients reconnecting with
    // Last-Event-ID still receive status changes made while offline.
    publishTransactionEvent({
      transactionId: id,
      userId: row.user_id ?? undefined,
      status,
      timestamp: new Date(row.updated_at ?? Date.now()).getTime(),
    });

    // ── Publish GraphQL subscription event ──────────────────────────────
    // Publish to both the per-transaction channel (targeted) and the
    // broadcast channel (for clients watching all transactions).
    try {
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
    } catch (pubsubErr) {
      console.warn(
        "[transaction] Failed to publish status update events",
        pubsubErr,
      );
    }

    return true;
  }

  async searchByNotes(query: string): Promise<Transaction[]> {
    const res = await queryRead<TransactionRow>(
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

  async getBalanceStatistics(
    userId: string,
  ): Promise<BalanceStatisticsRow | null> {
    const res = await queryRead<BalanceStatisticsRow>(
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
      [userId],
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

    const result = await queryRead<TransactionRow>(query, [userId, since]);
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

      const result = await queryRead<TransactionRow>(
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

      const result = await queryRead<TransactionRow>(
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
    const result = await queryRead<TransactionRow>(
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

    const result = await queryRead<{ total: number }>(
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

  async findRefundableFailedPayouts(limit = 100): Promise<Transaction[]> {
    const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE type = 'withdraw'
         AND status = $1
         AND COALESCE(metadata->'refund'->>'completedAt', '') = ''
         AND COALESCE(metadata->'refund'->>'status', '') <> 'processing'
       ORDER BY updated_at ASC, created_at ASC
       LIMIT $2`,
      [TransactionStatus.Failed, cappedLimit],
    );

    return result.rows
      .map(mapTransactionRow)
      .filter((t): t is Transaction => t !== null);
  }

  async countByStatuses(statuses: TransactionStatus[] = []): Promise<number> {
    return this.count(undefined, undefined, { statuses });
  }

  async findByUserId(userId: string): Promise<Transaction[]> {
    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE user_id = $1`,
      [userId],
    );

    return result.rows
      .map(mapTransactionRow)
      .filter((t): t is Transaction => t !== null);
  }

  async findByReferenceNumber(
    referenceNumber: string,
  ): Promise<Transaction | null> {
    if (
      !referenceNumber ||
      typeof referenceNumber !== "string" ||
      !referenceNumber.trim()
    ) {
      return null;
    }

    const trimmed = referenceNumber.trim();
    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE reference_number = $1
       LIMIT 1`,
      [trimmed],
    );

    return mapTransactionRow(result.rows[0]);
  }

  /**
   * Looks up a transaction by the provider's own reference (e.g. an M-Pesa
   * B2C `ConversationID`/`OriginatorConversationID`, stored on initiation as
   * `providerReference`). Used by provider result-webhook routes that only
   * receive the provider's identifiers, not our internal transaction id.
   */
  async findByProviderReference(
    providerReference: string,
  ): Promise<Transaction | null> {
    if (
      !providerReference ||
      typeof providerReference !== "string" ||
      !providerReference.trim()
    ) {
      return null;
    }

    const trimmed = providerReference.trim();
    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE provider_reference = $1
       LIMIT 1`,
      [trimmed],
    );

    return mapTransactionRow(result.rows[0]);
  }

  /**
   * Fast index check for transaction reference existence
   */
  async checkReferenceExists(referenceNumber: string): Promise<boolean> {
    if (!referenceNumber || typeof referenceNumber !== "string") {
      return false;
    }

    const result = await queryRead<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM transactions WHERE reference_number = $1
       ) AS exists`,
      [referenceNumber.trim()],
    );

    return Boolean(result.rows[0]?.exists);
  }

  async findByTags(tags: string[]): Promise<Transaction[]> {
    validateTags(tags);

    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE tags @> $1
       ORDER BY created_at DESC`,
      [tags],
    );

    return result.rows
      .map(mapTransactionRow)
      .filter((t): t is Transaction => t !== null);
  }

  async addTags(id: string, tags: string[]): Promise<Transaction | null> {
    validateTags(tags);

    const result = await queryWrite<TransactionRow>(
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
    const result = await queryWrite<TransactionRow>(
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
    const result = await queryWrite<TransactionRow>(
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
    const result = await queryWrite<TransactionRow>(
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

    const result = await queryWrite<TransactionRow>(
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

    const result = await queryWrite<TransactionRow>(
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

    const result = await queryWrite<TransactionRow>(
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
    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
       FROM transactions
       WHERE metadata @> $1::jsonb
       ORDER BY created_at DESC`,
      [JSON.stringify(filter)],
    );

    return result.rows
      .map(mapTransactionRow)
      .filter((t): t is Transaction => t !== null);
  }

  async searchByPhoneNumber(
    phoneNumber: string,
    limit = 50,
    offset = 0,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const off = Math.max(offset, 0);

    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [capped, off],
    );

    const mapped = result.rows
      .map(mapTransactionRow)
      .filter((t): t is Transaction => t !== null)
      .filter((t) => t.phoneNumber.includes(phoneNumber));

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
    const result = await queryRead<TransactionRow>(
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

    const result = await queryRead<TransactionRow>(
      `SELECT ${TRANSACTION_SELECT_COLUMNS}
        FROM transactions
        WHERE status = $1
          AND provider = $2
          AND type = $3
        ORDER BY created_at ASC
        LIMIT $4`,
      [status, provider.toLowerCase(), type, capped],
    );

    return result.rows
      .map(mapTransactionRow)
      .filter((t): t is Transaction => t !== null);
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

  /**
   * Atomically claims a pending transaction for processing to prevent race conditions across parallel worker instances.
   * Returns the transaction row if successfully claimed, or null if already claimed/processed.
   */
  async claimForProcessing(id: string): Promise<Transaction | null> {
    const res = await queryWrite<TransactionRow>(
      `UPDATE transactions
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND status = $3
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [TransactionStatus.Processing, id, TransactionStatus.Pending],
    );

    if (!res.rows || res.rows.length === 0) {
      return null;
    }

    return mapTransactionRow(res.rows[0]);
  }
}
