import { pool } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";

export interface User {
  id: string;
  phoneNumber: string;
  kycLevel: string;
  email?: string;
  two_factor_secret?: string | null;
  backup_codes?: string[] | null;
  status: 'active' | 'frozen' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}

export class UserModel {
  async findById(id: string): Promise<User | null> {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      phoneNumber: decrypt(row.phone_number) as string,
      kycLevel: row.kyc_level,
      email: decrypt(row.email) as string,
      two_factor_secret: decrypt(row.two_factor_secret) ?? null,
      backup_codes: row.backup_codes ?? null,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateEmail(id: string, email: string): Promise<void> {
    const encryptedEmail = encrypt(email);
    await pool.query("UPDATE users SET email = $1 WHERE id = $2", [encryptedEmail, id]);
  }

  async updateStatus(
    id: string,
    status: 'active' | 'frozen' | 'suspended',
    changedBy: string,
    reason?: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<User | null> {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get current user status for audit
      const currentUser = await this.findById(id);
      if (!currentUser) {
        await client.query('ROLLBACK');
        return null;
      }
      
      // Update user status
      const updateQuery = "UPDATE users SET status = $1 WHERE id = $2 RETURNING *";
      const result = await client.query(updateQuery, [status, id]);
      
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      
      // Log audit entry
      const auditQuery = `
        INSERT INTO user_status_audit (
          user_id, action, old_status, new_status, reason, changed_by, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;
      
      const action = status === 'frozen' ? 'FREEZE' : 
                     status === 'suspended' ? 'SUSPEND' : 
                     currentUser.status === 'frozen' ? 'UNFREEZE' : 'UNSUSPEND';
      
      await client.query(auditQuery, [
        id,
        action,
        currentUser.status,
        status,
        reason,
        changedBy,
        ipAddress,
        userAgent
      ]);
      
      await client.query('COMMIT');
      
      // Return updated user
      const row = result.rows[0];
      return {
        id: row.id,
        phoneNumber: decrypt(row.phone_number) as string,
        kycLevel: row.kyc_level,
        email: decrypt(row.email) as string,
        two_factor_secret: decrypt(row.two_factor_secret) ?? null,
        backup_codes: row.backup_codes ?? null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getAuditHistory(userId: string): Promise<any[]> {
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

    const result = await pool.query(query, [userId]);
    return result.rows;
  }
}
