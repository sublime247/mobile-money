import { pool } from "../config/database";

export interface RefreshTokenFamily {
  id: string;
  user_id: string;
  family_id: string;
  token: string;
  parent_token?: string;
  is_revoked: boolean;
  created_at: Date;
  revoked_at?: Date;
}

export class RefreshTokenFamilyModel {
  async create({ user_id, family_id, token, parent_token }: { user_id: string; family_id: string; token: string; parent_token?: string; }) {
    const result = await pool.query(
      `INSERT INTO refresh_token_families (user_id, family_id, token, parent_token) VALUES ($1, $2, $3, $4) RETURNING *`,
      [user_id, family_id, token, parent_token || null]
    );
    return result.rows[0];
  }

  async findByToken(token: string) {
    const result = await pool.query(
      `SELECT * FROM refresh_token_families WHERE token = $1`,
      [token]
    );
    return result.rows[0];
  }

  async revokeFamily(family_id: string) {
    await pool.query(
      `UPDATE refresh_token_families SET is_revoked = TRUE, revoked_at = NOW() WHERE family_id = $1`,
      [family_id]
    );
  }

  async isRevoked(token: string) {
    const result = await pool.query(
      `SELECT is_revoked FROM refresh_token_families WHERE token = $1`,
      [token]
    );
    return result.rows[0]?.is_revoked || false;
  }
}
