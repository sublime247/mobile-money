import { pool, queryRead, queryWrite } from "../config/database";
import {
  encrypt,
  decrypt,
  encryptField,
  decryptField,
} from "../utils/encryption";

export interface User {
  id: string;
  phoneNumber: string;
  kycLevel: string;
  preferredLanguage?: string;
  email?: string;
  displayName?: string | null;
  mcc?: string | null;
  two_factor_secret?: string | null;
  backup_codes?: string[] | null;
  backupPhoneNumber?: string | null;
  status: "active" | "frozen" | "suspended";
  tokenVersion?: number;
  createdAt: Date;
  updatedAt: Date;
  smsOptOut?: boolean;
  mandatory2FAWithdrawals?: boolean;
  settlementDelayDays?: number;
  // TODO: The `User` type and database table needs to
  // be update with these fields:  is_active: boolean,   deactivated_at:Date`

  // New sensitive fields
  firstName?: string;
  lastName?: string;
  address?: string;
  dateOfBirth?: string;
  idNumber?: string;
  deletedAt?: Date | null;
}

/**
 * Raw `users` table row (snake_case columns as returned by Postgres).
 * PII columns arrive encrypted and are decrypted in the mapping layer.
 */
export interface UsersTableRow {
  id: string;
  phone_number: string | null;
  kyc_level: string;
  preferred_language?: string | null;
  language?: string | null;
  email?: string | null;
  display_name?: string | null;
  two_factor_secret?: string | null;
  backup_codes?: string[] | null;
  backup_phone_number?: string | null;
  status: string;
  token_version?: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  sms_opt_out?: boolean | null;
  mandatory_2fa_withdrawals?: boolean | null;
  settlement_delay_days?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  address?: string | null;
  date_of_birth?: string | null;
  id_number?: string | null;
  deleted_at?: Date | string | null;
}

export interface AuditHistoryEntry {
  id: string;
  action: string;
  oldStatus: string;
  newStatus: string;
  reason: string | null;
  createdAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  changedByUser: string | null;
}

function mapUserRow(row: UsersTableRow): User {
  return {
    id: row.id,
    phoneNumber: (decryptField(row.phone_number) ||
      decrypt(row.phone_number)) as string,
    kycLevel: row.kyc_level,
    preferredLanguage: row.preferred_language ?? row.language ?? undefined,
    email: row.email
      ? ((decryptField(row.email) || decrypt(row.email)) as string)
      : undefined,
    displayName: row.display_name ?? null,
    two_factor_secret: row.two_factor_secret
      ? ((decryptField(row.two_factor_secret) ||
          decrypt(row.two_factor_secret)) as string)
      : null,
    backup_codes: row.backup_codes ?? null,
    backupPhoneNumber: row.backup_phone_number
      ? ((decryptField(row.backup_phone_number) ||
          decrypt(row.backup_phone_number)) as string)
      : null,
    status: row.status as User["status"],
    tokenVersion: row.token_version ?? 0,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    smsOptOut: row.sms_opt_out ?? false,
    mandatory2FAWithdrawals: row.mandatory_2fa_withdrawals ?? false,
    settlementDelayDays: row.settlement_delay_days ?? undefined,
    firstName: row.first_name
      ? (decryptField(row.first_name) as string)
      : undefined,
    lastName: row.last_name
      ? (decryptField(row.last_name) as string)
      : undefined,
    address: row.address ? (decryptField(row.address) as string) : undefined,
    dateOfBirth: row.date_of_birth
      ? (decryptField(row.date_of_birth) as string)
      : undefined,
    idNumber: row.id_number
      ? (decryptField(row.id_number) as string)
      : undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
  };
}

export class UserModel {
  /**
   * @param requester - existing authorization context (unchanged).
   * @param options.includeDeleted - bypasses the default
   * `deleted_at IS NULL` filter (#2376). Reserved for compliance/audit
   * callers; the standard API surface must never pass this, so a
   * soft-deleted user stays inaccessible through normal lookups.
   */
  async findById(
    id: string,
    requester?: { id: string; role: string },
    options?: { includeDeleted?: boolean },
  ): Promise<User | null> {
    const deletedFilter = options?.includeDeleted
      ? ""
      : "AND deleted_at IS NULL";
    const result = await queryRead<UsersTableRow>(
      `SELECT * FROM users WHERE id = $1 ${deletedFilter}`,
      [id],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const AUTHORIZED_ROLES = ["admin", "super-admin", "compliance_officer"];
    const isAuthorized =
      requester &&
      (AUTHORIZED_ROLES.includes(requester.role) || requester.id === id);

    return {
      id: row.id,
      phoneNumber: decrypt(row.phone_number) as string,
      kycLevel: row.kyc_level,
      preferredLanguage: row.preferred_language ?? row.language ?? undefined,
      email: decrypt(row.email) as string,
      displayName: row.display_name ?? null,
      two_factor_secret: decrypt(row.two_factor_secret) ?? null,
      backup_codes: row.backup_codes ?? null,
      backupPhoneNumber: row.backup_phone_number
        ? ((decryptField(row.backup_phone_number) ||
            decrypt(row.backup_phone_number)) as string)
        : null,
      status: row.status as User["status"],
      tokenVersion: row.token_version ?? 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      smsOptOut: row.sms_opt_out ?? false,
      mandatory2FAWithdrawals: row.mandatory_2fa_withdrawals ?? false,

      firstName: isAuthorized
        ? ((decryptField(row.first_name) as string) ?? undefined)
        : (row.first_name ?? undefined),
      lastName: isAuthorized
        ? ((decryptField(row.last_name) as string) ?? undefined)
        : (row.last_name ?? undefined),
      address: isAuthorized
        ? ((decryptField(row.address) as string) ?? undefined)
        : (row.address ?? undefined),
      dateOfBirth: isAuthorized
        ? ((decryptField(row.date_of_birth) as string) ?? undefined)
        : (row.date_of_birth ?? undefined),
      idNumber: isAuthorized
        ? ((decryptField(row.id_number) as string) ?? undefined)
        : (row.id_number ?? undefined),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    };
  }

  /**
   * Soft-deletes a user by setting deleted_at, honoring account closure
   * requests without a hard DELETE (#2376). Related rows (customer_wallets,
   * transactions, refresh_token_families, audit entries, etc.) are left
   * untouched since this is an UPDATE, not a DELETE - none of their
   * `REFERENCES users(id) ON DELETE CASCADE/RESTRICT/SET NULL` constraints
   * fire. Those rows become unreachable through the user's own default
   * (non-deleted) reads while remaining queryable by compliance/audit code
   * that joins on user_id directly or passes `includeDeleted: true` here.
   *
   * Idempotent: deleting an already-deleted user is a no-op that returns
   * the existing record rather than erroring.
   */
  async softDelete(id: string): Promise<User | null> {
    const result = await queryWrite<UsersTableRow>(
      `UPDATE users
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id],
    );
    if (result.rows.length > 0) {
      return mapUserRow(result.rows[0]);
    }
    return this.findById(id, undefined, { includeDeleted: true });
  }

  /** Reverses a soft delete, e.g. after a successful account-closure appeal. */
  async restore(id: string): Promise<User | null> {
    const result = await queryWrite<UsersTableRow>(
      `UPDATE users
       SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING *`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapUserRow(result.rows[0]);
  }

  async create(data: {
    phoneNumber: string;
    kycLevel?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    address?: string;
    dateOfBirth?: string;
    idNumber?: string;
    status?: "active" | "frozen" | "suspended";
  }): Promise<User> {
    const encryptedPhone =
      encryptField(data.phoneNumber) || encrypt(data.phoneNumber);
    const encryptedEmail = data.email
      ? encryptField(data.email) || encrypt(data.email)
      : null;
    const encryptedFirstName = data.firstName
      ? encryptField(data.firstName)
      : null;
    const encryptedLastName = data.lastName
      ? encryptField(data.lastName)
      : null;
    const encryptedAddress = data.address ? encryptField(data.address) : null;
    const encryptedDOB = data.dateOfBirth
      ? encryptField(data.dateOfBirth)
      : null;
    const encryptedIdNum = data.idNumber ? encryptField(data.idNumber) : null;

    const result = await queryWrite<UsersTableRow>(
      `INSERT INTO users (
        phone_number, kyc_level, email, first_name, last_name, address, date_of_birth, id_number, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        encryptedPhone,
        data.kycLevel || "basic",
        encryptedEmail,
        encryptedFirstName,
        encryptedLastName,
        encryptedAddress,
        encryptedDOB,
        encryptedIdNum,
        data.status || "active",
      ],
    );

    return mapUserRow(result.rows[0]);
  }

  async updateEmail(id: string, email: string): Promise<void> {
    const encryptedEmail = encryptField(email) || encrypt(email);
    await queryWrite("UPDATE users SET email = $1 WHERE id = $2", [
      encryptedEmail,
      id,
    ]);
  }

  async updateDisplayName(
    id: string,
    displayName: string | null,
  ): Promise<void> {
    await queryWrite(
      "UPDATE users SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [displayName, id],
    );
  }

  async updateSensitiveData(
    id: string,
    data: {
      firstName?: string;
      lastName?: string;
      address?: string;
      dateOfBirth?: string;
      idNumber?: string;
    },
  ): Promise<void> {
    const fields: string[] = [];
    const values: (string | null)[] = [];
    let paramIdx = 1;

    if (data.firstName !== undefined) {
      fields.push(`first_name = $${paramIdx++}`);
      values.push(encryptField(data.firstName));
    }
    if (data.lastName !== undefined) {
      fields.push(`last_name = $${paramIdx++}`);
      values.push(encryptField(data.lastName));
    }
    if (data.address !== undefined) {
      fields.push(`address = $${paramIdx++}`);
      values.push(encryptField(data.address));
    }
    if (data.dateOfBirth !== undefined) {
      fields.push(`date_of_birth = $${paramIdx++}`);
      values.push(encryptField(data.dateOfBirth));
    }
    if (data.idNumber !== undefined) {
      fields.push(`id_number = $${paramIdx++}`);
      values.push(encryptField(data.idNumber));
    }

    if (fields.length === 0) return;

    values.push(id);
    const query = `UPDATE users SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIdx}`;
    await queryWrite(query, values);
  }

  async updateStatus(
    id: string,
    status: "active" | "frozen" | "suspended",
    changedBy: string,
    reason?: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<User | null> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Get current user status for audit
      const currentUser = await this.findById(id);
      if (!currentUser) {
        await client.query("ROLLBACK");
        return null;
      }

      // Update user status
      const updateQuery =
        "UPDATE users SET status = $1 WHERE id = $2 RETURNING *";
      const result = await client.query<UsersTableRow>(updateQuery, [
        status,
        id,
      ]);

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      // Log audit entry
      const auditQuery = `
        INSERT INTO user_status_audit (
          user_id, action, old_status, new_status, reason, changed_by, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;

      const action =
        status === "frozen"
          ? "FREEZE"
          : status === "suspended"
            ? "SUSPEND"
            : currentUser.status === "frozen"
              ? "UNFREEZE"
              : "UNSUSPEND";

      await client.query(auditQuery, [
        id,
        action,
        currentUser.status,
        status,
        reason,
        changedBy,
        ipAddress,
        userAgent,
      ]);

      await client.query("COMMIT");

      // Return updated user
      return mapUserRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAuditHistory(userId: string): Promise<AuditHistoryEntry[]> {
    const query = `
      SELECT 
        a.id,
        a.action,
        a.old_status AS "oldStatus",
        a.new_status AS "newStatus",
        a.reason,
        a.created_at AS "createdAt",
        a.ip_address AS "ipAddress",
        a.user_agent AS "userAgent",
        u.phone_number AS "changedByUser"
      FROM user_status_audit a
      JOIN users u ON a.changed_by = u.id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `;

    const result = await queryRead<AuditHistoryEntry>(query, [userId]);
    return result.rows;
  }
  async incrementTokenVersion(id: string): Promise<number> {
    const query = `
      UPDATE users 
      SET token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 
      RETURNING token_version
    `;
    const result = await queryWrite(query, [id]);
    return result.rows[0]?.token_version || 0;
  }

  async updateMandatory2FAWithdrawals(
    id: string,
    enabled: boolean,
  ): Promise<void> {
    await queryWrite(
      "UPDATE users SET mandatory_2fa_withdrawals = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [enabled, id],
    );
  }

  async updateBackupPhoneNumber(
    id: string,
    backupPhoneNumber: string | null,
  ): Promise<void> {
    const encryptedPhone = backupPhoneNumber
      ? encryptField(backupPhoneNumber) || encrypt(backupPhoneNumber)
      : null;
    await queryWrite(
      "UPDATE users SET backup_phone_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [encryptedPhone, id],
    );
  }
}
