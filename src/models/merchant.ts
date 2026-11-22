import { queryRead, queryWrite, pool } from "../config/database";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

export interface Merchant {
  id: string;
  name: string;
  email: string;
  phoneNumber: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country: string;
  status: "pending" | "active" | "suspended" | "rejected";
  kycStatus: "not_started" | "in_progress" | "verified" | "rejected";
  invitationToken?: string;
  invitationSentAt?: Date;
  invitationAcceptedAt?: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface MerchantRow {
  id: string;
  name: string;
  email: string;
  phone_number: string;
  business_name?: string | null;
  business_type?: string | null;
  tax_id?: string | null;
  address?: string | null;
  city?: string | null;
  country: string;
  status: Merchant["status"] | string;
  kyc_status: Merchant["kycStatus"] | string;
  invitation_token?: string | null;
  invitation_sent_at?: Date | string | null;
  invitation_accepted_at?: Date | string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at?: Date | string | null;
}

export interface CreateMerchantInput {
  name: string;
  email: string;
  phoneNumber: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateMerchantInput {
  name?: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country?: string;
  status?: "pending" | "active" | "suspended" | "rejected";
  kycStatus?: "not_started" | "in_progress" | "verified" | "rejected";
  metadata?: Record<string, unknown>;
}

export interface MerchantBatchJob {
  id: string;
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed";
  totalRecords: number;
  processedRecords: number;
  succeededRecords: number;
  failedRecords: number;
  errors: Array<{ row: number; error: string; email?: string }>;
  createdBy: string;
  createdAt: Date;
  completedAt?: Date;
}

export class MerchantModel {
  async create(input: CreateMerchantInput): Promise<Merchant> {
    const id = uuidv4();
    const invitationToken = crypto.randomBytes(32).toString("hex");

    const query = `
      INSERT INTO merchants (
        id, name, email, phone_number, business_name, business_type,
        tax_id, address, city, country, status, kyc_status,
        invitation_token, invitation_sent_at, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'not_started', $11, NULL, $12)
      RETURNING *
    `;

    const result = await queryWrite<MerchantRow>(query, [
      id,
      input.name,
      input.email.toLowerCase().trim(),
      input.phoneNumber,
      input.businessName || null,
      input.businessType || null,
      input.taxId || null,
      input.address || null,
      input.city || null,
      input.country || "CM",
      invitationToken,
      JSON.stringify(input.metadata || {}),
    ]);

    const row = result.rows[0];
    return this.mapRowToMerchant(row);
  }

  async createMany(
    merchants: CreateMerchantInput[],
    createdBy: string,
  ): Promise<{
    created: Merchant[];
    errors: Array<{ row: number; error: string; email?: string }>;
  }> {
    const created: Merchant[] = [];
    const errors: Array<{ row: number; error: string; email?: string }> = [];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (let i = 0; i < merchants.length; i++) {
        const input = merchants[i];
        const rowNum = i + 2; // Row 1 is header, data starts at row 2

        try {
          const id = uuidv4();
          const invitationToken = crypto.randomBytes(32).toString("hex");

          const query = `
            INSERT INTO merchants (
              id, name, email, phone_number, business_name, business_type,
              tax_id, address, city, country, status, kyc_status,
              invitation_token, invitation_sent_at, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'not_started', $11, NULL, $12)
            RETURNING *
          `;

          const result = await client.query<MerchantRow>(query, [
            id,
            input.name,
            input.email.toLowerCase().trim(),
            input.phoneNumber,
            input.businessName || null,
            input.businessType || null,
            input.taxId || null,
            input.address || null,
            input.city || null,
            input.country || "CM",
            invitationToken,
            JSON.stringify(input.metadata || {}),
          ]);

          created.push(this.mapRowToMerchant(result.rows[0]));
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          errors.push({
            row: rowNum,
            error: errorMessage,
            email: input.email,
          });
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return { created, errors };
  }

  /**
   * @param options.includeDeleted - When true, bypasses the default
   * `deleted_at IS NULL` filter so soft-deleted merchants are visible. This
   * is reserved for compliance/audit callers (e.g. retention reporting,
   * dispute investigation on a closed account) - the standard API surface
   * must never pass this.
   */
  async findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Merchant | null> {
    const deletedFilter = options?.includeDeleted
      ? ""
      : "AND deleted_at IS NULL";
    const result = await queryRead<MerchantRow>(
      `SELECT * FROM merchants WHERE id = $1 ${deletedFilter}`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async findByEmail(
    email: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Merchant | null> {
    const deletedFilter = options?.includeDeleted
      ? ""
      : "AND deleted_at IS NULL";
    const result = await queryRead<MerchantRow>(
      `SELECT * FROM merchants WHERE email = $1 ${deletedFilter}`,
      [email.toLowerCase().trim()],
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async findByInvitationToken(token: string): Promise<Merchant | null> {
    const result = await queryRead<MerchantRow>(
      "SELECT * FROM merchants WHERE invitation_token = $1 AND deleted_at IS NULL",
      [token],
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async update(
    id: string,
    input: UpdateMerchantInput,
  ): Promise<Merchant | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      sets.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.businessName !== undefined) {
      sets.push(`business_name = $${paramIndex++}`);
      values.push(input.businessName);
    }
    if (input.businessType !== undefined) {
      sets.push(`business_type = $${paramIndex++}`);
      values.push(input.businessType);
    }
    if (input.taxId !== undefined) {
      sets.push(`tax_id = $${paramIndex++}`);
      values.push(input.taxId);
    }
    if (input.address !== undefined) {
      sets.push(`address = $${paramIndex++}`);
      values.push(input.address);
    }
    if (input.city !== undefined) {
      sets.push(`city = $${paramIndex++}`);
      values.push(input.city);
    }
    if (input.country !== undefined) {
      sets.push(`country = $${paramIndex++}`);
      values.push(input.country);
    }
    if (input.status !== undefined) {
      sets.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.kycStatus !== undefined) {
      sets.push(`kyc_status = $${paramIndex++}`);
      values.push(input.kycStatus);
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(input.metadata));
    }

    if (sets.length === 0) {
      return this.findById(id);
    }

    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `UPDATE merchants SET ${sets.join(", ")} WHERE id = $${paramIndex} RETURNING *`;
    const result = await queryWrite<MerchantRow>(query, values);

    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  /**
   * Soft-deletes a merchant by setting deleted_at, honoring account closure
   * requests without a hard DELETE (#2376). Related rows in other tables
   * (merchant_webhooks, merchant_api_keys, transactions, etc.) are left
   * untouched - this is an UPDATE, not a DELETE, so none of their FK
   * constraints fire. Those rows simply become unreachable through the
   * merchant's own default (non-deleted) reads, while still queryable by
   * compliance/audit code paths that join on merchant_id directly or pass
   * `includeDeleted: true` here.
   *
   * Idempotent: deleting an already-deleted merchant is a no-op that
   * returns the existing record rather than erroring.
   */
  async softDelete(id: string): Promise<Merchant | null> {
    const result = await queryWrite<MerchantRow>(
      `UPDATE merchants
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id],
    );
    if (result.rows.length > 0) {
      return this.mapRowToMerchant(result.rows[0]);
    }
    // Either not found, or already deleted - distinguish by re-reading with
    // includeDeleted so a caller can tell "already closed" from "no such
    // merchant" without a second round trip in the common case.
    return this.findById(id, { includeDeleted: true });
  }

  /** Reverses a soft delete, e.g. after a successful account-closure appeal. */
  async restore(id: string): Promise<Merchant | null> {
    const result = await queryWrite<MerchantRow>(
      `UPDATE merchants
       SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING *`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async markInvitationSent(id: string): Promise<void> {
    await queryWrite(
      "UPDATE merchants SET invitation_sent_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id],
    );
  }

  async acceptInvitation(id: string): Promise<Merchant | null> {
    const query = `
      UPDATE merchants 
      SET 
        invitation_accepted_at = CURRENT_TIMESTAMP,
        status = 'active',
        invitation_token = NULL
      WHERE id = $1
      RETURNING *
    `;

    const result = await queryWrite<MerchantRow>(query, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async list(options?: {
    page?: number;
    limit?: number;
    status?: string;
    kycStatus?: string;
    /** Compliance/audit escape hatch: include soft-deleted merchants. */
    includeDeleted?: boolean;
  }): Promise<{ merchants: Merchant[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (!options?.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }
    if (options?.kycStatus) {
      conditions.push(`kyc_status = $${paramIndex++}`);
      values.push(options.kycStatus);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM merchants ${whereClause}`;
    const countResult = await queryRead<{ total: string }>(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total || "0", 10);

    const dataQuery = `
      SELECT * FROM merchants ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    values.push(limit, offset);

    const result = await queryRead<MerchantRow>(dataQuery, values);
    const merchants = result.rows.map((row) => this.mapRowToMerchant(row));

    return { merchants, total };
  }

  async getBatchJob(jobId: string): Promise<MerchantBatchJob | null> {
    const result = await queryRead<MerchantBatchJobRow>(
      "SELECT * FROM merchant_batch_jobs WHERE job_id = $1",
      [jobId],
    );
    if (result.rows.length === 0) return null;

    return this.mapBatchJobRow(result.rows[0]);
  }

  async createBatchJob(
    jobId: string,
    totalRecords: number,
    createdBy: string,
  ): Promise<MerchantBatchJob> {
    const id = uuidv4();
    const query = `
      INSERT INTO merchant_batch_jobs (
        id, job_id, status, total_records, processed_records,
        succeeded_records, failed_records, errors, created_by
      )
      VALUES ($1, $2, 'pending', $3, 0, 0, 0, '[]', $4)
      RETURNING *
    `;

    const result = await queryWrite<MerchantBatchJobRow>(query, [
      id,
      jobId,
      totalRecords,
      createdBy,
    ]);
    return this.mapBatchJobRow(result.rows[0]);
  }

  private mapBatchJobRow(row: MerchantBatchJobRow): MerchantBatchJob {
    return {
      id: row.id,
      jobId: row.job_id,
      status: row.status as MerchantBatchJob["status"],
      totalRecords: row.total_records,
      processedRecords: row.processed_records,
      succeededRecords: row.succeeded_records,
      failedRecords: row.failed_records,
      errors: row.errors ?? [],
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }

  async updateBatchJob(
    jobId: string,
    updates: {
      status?: string;
      processedRecords?: number;
      succeededRecords?: number;
      failedRecords?: number;
      errors?: Array<{ row: number; error: string; email?: string }>;
      completedAt?: Date;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      sets.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.processedRecords !== undefined) {
      sets.push(`processed_records = $${paramIndex++}`);
      values.push(updates.processedRecords);
    }
    if (updates.succeededRecords !== undefined) {
      sets.push(`succeeded_records = $${paramIndex++}`);
      values.push(updates.succeededRecords);
    }
    if (updates.failedRecords !== undefined) {
      sets.push(`failed_records = $${paramIndex++}`);
      values.push(updates.failedRecords);
    }
    if (updates.errors !== undefined) {
      sets.push(`errors = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(updates.errors));
    }
    if (updates.completedAt !== undefined) {
      sets.push(`completed_at = $${paramIndex++}`);
      values.push(updates.completedAt);
    }

    if (sets.length === 0) return;

    values.push(jobId);
    const query = `UPDATE merchant_batch_jobs SET ${sets.join(", ")} WHERE job_id = $${paramIndex}`;
    await queryWrite(query, values);
  }

  private mapRowToMerchant(row: MerchantRow): Merchant {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phoneNumber: row.phone_number,
      businessName: row.business_name ?? undefined,
      businessType: row.business_type ?? undefined,
      taxId: row.tax_id ?? undefined,
      address: row.address ?? undefined,
      city: row.city ?? undefined,
      country: row.country,
      status: row.status as Merchant["status"],
      kycStatus: row.kyc_status as Merchant["kycStatus"],
      invitationToken: row.invitation_token ?? undefined,
      invitationSentAt: row.invitation_sent_at
        ? new Date(row.invitation_sent_at)
        : undefined,
      invitationAcceptedAt: row.invitation_accepted_at
        ? new Date(row.invitation_accepted_at)
        : undefined,
      metadata: row.metadata ?? {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    };
  }
}

export interface MerchantBatchJobRow {
  id: string;
  job_id: string;
  status: MerchantBatchJob["status"] | string;
  total_records: number;
  processed_records: number;
  succeeded_records: number;
  failed_records: number;
  errors: Array<{ row: number; error: string; email?: string }> | null;
  created_by: string;
  created_at: Date | string;
  completed_at?: Date | string | null;
}
