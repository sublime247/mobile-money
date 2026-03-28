import { pool } from "../config/database";
import { v4 as uuidv4 } from "uuid";

export interface Referral {
  id: string;
  user_id: string;
  referral_code: string;
  referred_by?: string;
  reward_granted: boolean;
  created_at: Date;
}

export class ReferralModel {
  async createReferral(user_id: string, referred_by?: string) {
    const referral_code = uuidv4().replace(/-/g, '').slice(0, 10);
    const result = await pool.query(
      `INSERT INTO referrals (user_id, referral_code, referred_by) VALUES ($1, $2, $3) RETURNING *`,
      [user_id, referral_code, referred_by || null]
    );
    return result.rows[0];
  }

  async findByCode(referral_code: string) {
    const result = await pool.query(
      `SELECT * FROM referrals WHERE referral_code = $1`,
      [referral_code]
    );
    return result.rows[0];
  }

  async markRewardGranted(id: string) {
    await pool.query(
      `UPDATE referrals SET reward_granted = TRUE WHERE id = $1`,
      [id]
    );
  }

  async hasUsedReferral(user_id: string) {
    const result = await pool.query(
      `SELECT * FROM referrals WHERE user_id = $1 AND referred_by IS NOT NULL`,
      [user_id]
    );
    return result.rows.length > 0;
  }
}
