import { Request, Response } from "express";
import { z } from "zod";
import { twoFactorWithdrawalService } from "../services/twoFactorWithdrawalService";
import { UserModel } from "../models/users";
import { is2FAEnabled } from "../auth/2fa";
import logger from "../utils/logger";

// Validation schemas
const updateMandatory2FASchema = z.object({
  enabled: z.boolean({
    required_error: "enabled field is required",
    invalid_type_error: "enabled must be a boolean",
  }),
});

const verify2FASchema = z
  .object({
    token: z.string().optional(),
    backupCode: z.string().optional(),
  })
  .refine((data) => data.token || data.backupCode, {
    message: "Either token or backupCode must be provided",
  });

/**
 * Get user's 2FA withdrawal settings
 */
export const getWithdrawal2FASettings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const settings =
      await twoFactorWithdrawalService.getWithdrawal2FASettings(userId);

    return res.json({
      mandatory2FAWithdrawals: settings.mandatory2FAWithdrawals,
      has2FAEnabled: settings.has2FAEnabled,
      canEnableMandatory: settings.canEnableMandatory,
    });
  } catch (error) {
    logger.error("[2FA] Error getting withdrawal 2FA settings:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Update user's mandatory 2FA withdrawal preference
 */
export const updateMandatory2FAWithdrawals = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Validate request body
    const validationResult = updateMandatory2FASchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: validationResult.error.issues,
      });
    }

    const { enabled } = validationResult.data;

    // If enabling, require current 2FA verification
    if (enabled) {
      const verificationResult = verify2FASchema.safeParse(req.body);
      if (!verificationResult.success) {
        return res.status(400).json({
          error: "2FA verification required to enable mandatory withdrawals",
          code: "VERIFICATION_REQUIRED",
          message:
            "Please provide a TOTP token or backup code to confirm this change",
        });
      }

      const twoFactorResult =
        await twoFactorWithdrawalService.verifyWithdrawal2FA({
          userId,
          token: verificationResult.data.token,
          backupCode: verificationResult.data.backupCode,
        });

      if (!twoFactorResult.success) {
        return res.status(401).json({
          error: "2FA verification failed",
          code: "VERIFICATION_FAILED",
          message: twoFactorResult.error || "Invalid 2FA token or backup code",
        });
      }
    }

    // Update the preference
    await twoFactorWithdrawalService.updateMandatory2FAWithdrawals(
      userId,
      enabled,
    );

    logger.info(`[2FA] Updated mandatory 2FA withdrawals`, {
      userId,
      enabled,
      verified: enabled,
    });

    return res.json({
      success: true,
      mandatory2FAWithdrawals: enabled,
      message: enabled
        ? "Mandatory 2FA for withdrawals has been enabled"
        : "Mandatory 2FA for withdrawals has been disabled",
    });
  } catch (error: any) {
    logger.error("[2FA] Error updating mandatory 2FA withdrawals:", error);

    if (
      error.message?.includes(
        "Cannot enable mandatory 2FA withdrawals without 2FA being enabled",
      )
    ) {
      return res.status(400).json({
        error: "Cannot enable mandatory withdrawals",
        code: "REQUIREMENTS_NOT_MET",
        message:
          "You must first enable 2FA before requiring it for withdrawals",
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Verify 2FA for testing purposes (optional endpoint)
 */
export const verifyWithdrawal2FA = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const validationResult = verify2FASchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: validationResult.error.issues,
      });
    }

    const { token, backupCode } = validationResult.data;

    const result = await twoFactorWithdrawalService.verifyWithdrawal2FA({
      userId,
      token,
      backupCode,
    });

    return res.json({
      success: result.success,
      method: result.method,
      error: result.error,
    });
  } catch (error) {
    logger.error("[2FA] Error verifying withdrawal 2FA:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
