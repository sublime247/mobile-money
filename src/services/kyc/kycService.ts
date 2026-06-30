import { pool } from "../../config/database";
import { KYCLevel } from "../../config/limits";

export interface User {
  id: string;
  kycLevel: KYCLevel;
  phoneNumber: string;
  createdAt: Date;
}

export class KYCService {
  async getUserKYCLevel(userId: string): Promise<KYCLevel> {
    const result = await pool.query(
      "SELECT kyc_level FROM users WHERE id = $1",
      [userId],
    );

    if (!result.rows[0]) {
      throw new Error("User not found");
    }

    return result.rows[0].kyc_level as KYCLevel;
  }

  async getUserByPhoneNumber(phoneNumber: string): Promise<User | null> {
    const result = await pool.query(
      "SELECT id, kyc_level, phone_number, created_at FROM users WHERE phone_number = $1",
      [phoneNumber],
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      kycLevel: row.kyc_level as KYCLevel,
      phoneNumber: row.phone_number,
      createdAt: row.created_at,
    };
  }
}
