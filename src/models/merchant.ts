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
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
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
  metadata?: Record<string, any>;
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
  metadata?: Record<string, any>;
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

    const result = await queryWrite(query, [
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
    createdBy: string
  ): Promise<{ created: Merchant[]; errors: Array<{ row: number; error: string; email?: string }> }> {
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

          const result = await client.query(query, [
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
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
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

  async findById(id: string): Promise<Merchant | null> {
    const result = await queryRead("SELECT * FROM merchants WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async findByEmail(email: string): Promise<Merchant | null> {
    const result = await queryRead("SELECT * FROM merchants WHERE email = $1", [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async findByInvitationToken(token: string): Promise<Merchant | null> {
    const result = await queryRead("SELECT * FROM merchants WHERE invitation_token = $1", [token]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async update(id: string, input: UpdateMerchantInput): Promise<Merchant | null> {
    const sets: string[] = [];
    const values: any[] = [];
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
    const result = await queryWrite(query, values);

    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async markInvitationSent(id: string): Promise<void> {
    await queryWrite(
      "UPDATE merchants SET invitation_sent_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
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

    const result = await queryWrite(query, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async list(options?: {
    page?: number;
    limit?: number;
    status?: string;
    kycStatus?: string;
  }): Promise<{ merchants: Merchant[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }
    if (options?.kycStatus) {
      conditions.push(`kyc_status = $${paramIndex++}`);
      values.push(options.kycStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM merchants ${whereClause}`;
    const countResult = await queryRead(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total || "0", 10);

    const dataQuery = `
      SELECT * FROM merchants ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    values.push(limit, offset);

    const result = await queryRead(dataQuery, values);
    const merchants = result.rows.map((row: any) => this.mapRowToMerchant(row));

    return { merchants, total };
  }

  async getBatchJob(jobId: string): Promise<MerchantBatchJob | null> {
    const result = await queryRead(
      "SELECT * FROM merchant_batch_jobs WHERE job_id = $1",
      [jobId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      totalRecords: row.total_records,
      processedRecords: row.processed_records,
      succeededRecords: row.succeeded_records,
      failedRecords: row.failed_records,
      errors: row.errors || [],
      createdBy: row.created_by,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  async createBatchJob(
    jobId: string,
    totalRecords: number,
    createdBy: string
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

    const result = await queryWrite(query, [id, jobId, totalRecords, createdBy]);
    const row = result.rows[0];

    return {
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      totalRecords: row.total_records,
      processedRecords: row.processed_records,
      succeededRecords: row.succeeded_records,
      failedRecords: row.failed_records,
      errors: row.errors || [],
      createdBy: row.created_by,
      createdAt: row.created_at,
      completedAt: row.completed_at,
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
    }
  ): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
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

  private mapRowToMerchant(row: any): Merchant {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phoneNumber: row.phone_number,
      businessName: row.business_name,
      businessType: row.business_type,
      taxId: row.tax_id,
      address: row.address,
      city: row.city,
      country: row.country,
      status: row.status,
      kycStatus: row.kyc_status,
      invitationToken: row.invitation_token,
      invitationSentAt: row.invitation_sent_at,
      invitationAcceptedAt: row.invitation_accepted_at,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}