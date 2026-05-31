import { UserModel } from "../models/users";
import { is2FAEnabled, verifyTOTPToken } from "../auth/2fa";
import { pool, queryRead } from "../config/database";
import bcrypt from "bcrypt";
import logger from "../utils/logger";

export interface TwoFactorVerificationRequest {
  userId: string;
  token?: string; // TOTP token
  backupCode?: string; // Backup code
}

export interface TwoFactorVerificationResult {
  success: boolean;
  method?: "totp" | "backup";
  error?: string;
}

export class TwoFactorWithdrawalService {
  private userModel: UserModel;

  constructor() {
    this.userModel = new UserModel();
  }

  /**
   * Check if user requires 2FA for withdrawals
   */
  async requires2FAForWithdrawal(userId: string): Promise<boolean> {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    return user.mandatory2FAWithdrawals === true;
  }

  /**
   * Verify 2FA token for withdrawal
   */
  async verifyWithdrawal2FA(
    request: TwoFactorVerificationRequest,
  ): Promise<TwoFactorVerificationResult> {
    const user = await this.userModel.findById(request.userId);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Check if 2FA is enabled for the user
    if (!is2FAEnabled(user)) {
      return { success: false, error: "2FA not enabled for user" };
    }

    // Check if user requires mandatory 2FA for withdrawals
    if (!user.mandatory2FAWithdrawals) {
      return {
        success: false,
        error: "User has not opted into mandatory 2FA withdrawals",
      };
    }

    // Try TOTP verification first
    if (request.token) {
      const isValidTOTP = verifyTOTPToken(
        user.two_factor_secret!,
        request.token,
      );
      if (isValidTOTP) {
        logger.info(`[2FA] Successful TOTP verification for withdrawal`, {
          userId: request.userId,
          method: "totp",
        });
        return { success: true, method: "totp" };
      }
    }

    // Try backup code verification
    if (request.backupCode) {
      const backupCodeResult = await this.verifyBackupCode(
        request.userId,
        request.backupCode,
      );
      if (backupCodeResult.success) {
        logger.info(
          `[2FA] Successful backup code verification for withdrawal`,
          {
            userId: request.userId,
            method: "backup",
            codeId: backupCodeResult.codeId,
          },
        );
        return { success: true, method: "backup" };
      }
    }

    logger.warn(`[2FA] Failed 2FA verification for withdrawal`, {
      userId: request.userId,
      hasToken: !!request.token,
      hasBackupCode: !!request.backupCode,
    });

    return { success: false, error: "Invalid 2FA token or backup code" };
  }

  /**
   * Update user's mandatory 2FA withdrawal preference
   */
  async updateMandatory2FAWithdrawals(
    userId: string,
    enabled: boolean,
  ): Promise<void> {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    // If enabling mandatory 2FA, ensure user has 2FA enabled
    if (enabled && !is2FAEnabled(user)) {
      throw new Error(
        "Cannot enable mandatory 2FA withdrawals without 2FA being enabled",
      );
    }

    await this.userModel.updateMandatory2FAWithdrawals(userId, enabled);

    logger.info(`[2FA] Updated mandatory 2FA withdrawals preference`, {
      userId,
      enabled,
      has2FAEnabled: is2FAEnabled(user),
    });
  }

  /**
   * Get user's 2FA withdrawal settings
   */
  async getWithdrawal2FASettings(userId: string): Promise<{
    mandatory2FAWithdrawals: boolean;
    has2FAEnabled: boolean;
    canEnableMandatory: boolean;
  }> {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const has2FAEnabled = is2FAEnabled(user);
    const canEnableMandatory = has2FAEnabled;

    return {
      mandatory2FAWithdrawals: user.mandatory2FAWithdrawals || false,
      has2FAEnabled,
      canEnableMandatory,
    };
  }

  /**
   * Verify backup code for withdrawal
   */
  private async verifyBackupCode(
    userId: string,
    code: string,
  ): Promise<{ success: boolean; codeId?: string }> {
    try {
      const client = await pool.connect();

      try {
        // Get unused backup codes for user
        const query = `
          SELECT id, code_hash
          FROM backup_codes
          WHERE user_id = $1 AND used = FALSE
          ORDER BY created_at ASC
        `;

        const result = await client.query(query, [userId]);
        const backupCodes = result.rows;

        // Check each backup code
        for (const backupCode of backupCodes) {
          const isValid = await bcrypt.compare(code, backupCode.code_hash);
          if (isValid) {
            // Mark code as used
            await client.query(
              "UPDATE backup_codes SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1",
              [backupCode.id],
            );

            return { success: true, codeId: backupCode.id };
          }
        }

        return { success: false };
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error("[2FA] Error verifying backup code:", error);
      return { success: false };
    }
  }
}

export const twoFactorWithdrawalService = new TwoFactorWithdrawalService();
