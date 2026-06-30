import { pool, queryRead, queryWrite } from "../config/database";

export interface AdminStellarKey {
  id: string;
  publicKey: string;
  description?: string;
  isActive: boolean;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
  deactivatedAt?: Date;
}

export interface AdminStellarKeyCreateInput {
  publicKey: string;
  description?: string;
  createdBy?: string;
}

export interface AdminStellarKeyUpdateInput {
  description?: string;
  isActive?: boolean;
}

export class AdminStellarKeyModel {
  /**
   * Check if a Stellar public key is authorized for admin access
   */
  async isAdminKey(publicKey: string): Promise<boolean> {
    const result = await queryRead(
      "SELECT id FROM admin_stellar_keys WHERE public_key = $1 AND is_active = true",
      [publicKey],
    );
    return result.rows.length > 0;
  }

  /**
   * Get all active admin Stellar keys
   */
  async findAllActive(): Promise<AdminStellarKey[]> {
    const result = await queryRead(
      "SELECT * FROM admin_stellar_keys WHERE is_active = true ORDER BY created_at DESC",
    );

    return result.rows.map((row) => ({
      id: row.id,
      publicKey: row.public_key,
      description: row.description,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deactivatedAt: row.deactivated_at,
    }));
  }

  /**
   * Get admin Stellar key by public key
   */
  async findByPublicKey(publicKey: string): Promise<AdminStellarKey | null> {
    const result = await queryRead(
      "SELECT * FROM admin_stellar_keys WHERE public_key = $1",
      [publicKey],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      publicKey: row.public_key,
      description: row.description,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deactivatedAt: row.deactivated_at,
    };
  }

  /**
   * Create a new admin Stellar key
   */
  async create(input: AdminStellarKeyCreateInput): Promise<AdminStellarKey> {
    const result = await queryWrite(
      `INSERT INTO admin_stellar_keys (public_key, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.publicKey, input.description, input.createdBy],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      publicKey: row.public_key,
      description: row.description,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deactivatedAt: row.deactivated_at,
    };
  }

  /**
   * Update an admin Stellar key
   */
  async update(
    publicKey: string,
    input: AdminStellarKeyUpdateInput,
  ): Promise<AdminStellarKey | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(input.description);
    }

    if (input.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(input.isActive);
      if (!input.isActive) {
        updates.push(`deactivated_at = CURRENT_TIMESTAMP`);
      } else {
        updates.push(`deactivated_at = NULL`);
      }
    }

    if (updates.length === 0) return null;

    values.push(publicKey);

    const result = await queryWrite(
      `UPDATE admin_stellar_keys
       SET ${updates.join(", ")}
       WHERE public_key = $${paramIndex}
       RETURNING *`,
      values,
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      publicKey: row.public_key,
      description: row.description,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deactivatedAt: row.deactivated_at,
    };
  }

  /**
   * Deactivate an admin Stellar key
   */
  async deactivate(publicKey: string): Promise<boolean> {
    const result = await queryWrite(
      `UPDATE admin_stellar_keys
       SET is_active = false, deactivated_at = CURRENT_TIMESTAMP
       WHERE public_key = $1 AND is_active = true`,
      [publicKey],
    );
    return result.rowCount > 0;
  }

  /**
   * Delete an admin Stellar key
   */
  async delete(publicKey: string): Promise<boolean> {
    const result = await queryWrite(
      "DELETE FROM admin_stellar_keys WHERE public_key = $1",
      [publicKey],
    );
    return result.rowCount > 0;
  }
}

export const adminStellarKeyModel = new AdminStellarKeyModel();
