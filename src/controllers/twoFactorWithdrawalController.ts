import { Request, Response } from "express";
import { z } from "zod";
import { twoFactorWithdrawalService } from "../services/twoFactorWithdrawalService";
import { UserModel } from "../models/users";
import { is2FAEnabled } from "../auth/2fa";
import logger from "../utils/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

// Validation schemas
const updateMandatory2FASchema = z.object({
  enabled: z.boolean({
    message: "enabled must be a boolean",
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
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
        error: "Unauthorized",
      });
    }

    const settings =
      await twoFactorWithdrawalService.getWithdrawal2FASettings(userId);

    return res.json({
      mandatory2FAWithdrawals: settings.mandatory2FAWithdrawals,
      has2FAEnabled: settings.has2FAEnabled,
      canEnableMandatory: settings.canEnableMandatory,
    });
  } catch (error) {
    logger.error(error, "[2FA] Error getting withdrawal 2FA settings");
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error", {
      error: "Internal server error",
    });
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
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
        error: "Unauthorized",
      });
    }

    // Validate request body
    const validationResult = updateMandatory2FASchema.safeParse(req.body);
    if (!validationResult.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
        error: "Validation failed",
        details: validationResult.error.issues,
      });
    }

    const { enabled } = validationResult.data;

    // If enabling, require current 2FA verification
    if (enabled) {
      const verificationResult = verify2FASchema.safeParse(req.body);
      if (!verificationResult.success) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Please provide a TOTP token or backup code to confirm this change",
          {
            error: "2FA verification required to enable mandatory withdrawals",
            code: "VERIFICATION_REQUIRED",
          },
        );
      }

      const twoFactorResult =
        await twoFactorWithdrawalService.verifyWithdrawal2FA({
          userId,
          token: verificationResult.data.token,
          backupCode: verificationResult.data.backupCode,
        });

      if (!twoFactorResult.success) {
        throw createError(
          ERROR_CODES.INVALID_CREDENTIALS,
          twoFactorResult.error || "Invalid 2FA token or backup code",
          {
            error: "2FA verification failed",
            code: "VERIFICATION_FAILED",
          },
        );
      }
    }

    // Update the preference
    await twoFactorWithdrawalService.updateMandatory2FAWithdrawals(
      userId,
      enabled,
    );

    logger.info({
      userId,
      enabled,
      verified: enabled,
    }, `[2FA] Updated mandatory 2FA withdrawals`);

    return res.json({
      success: true,
      mandatory2FAWithdrawals: enabled,
      message: enabled
        ? "Mandatory 2FA for withdrawals has been enabled"
        : "Mandatory 2FA for withdrawals has been disabled",
    });
  } catch (error: any) {
    logger.error(error, "[2FA] Error updating mandatory 2FA withdrawals");

    if (
      error.message?.includes(
        "Cannot enable mandatory 2FA withdrawals without 2FA being enabled",
      )
    ) {
      throw createError(
        ERROR_CODES.MISSING_FIELD,
        "You must first enable 2FA before requiring it for withdrawals",
        {
          error: "Cannot enable mandatory withdrawals",
          code: "REQUIREMENTS_NOT_MET",
        },
      );
    }
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error", {
      error: "Internal server error",
    });
  }
};

/**
 * Verify 2FA for testing purposes (optional endpoint)
 */
export const verifyWithdrawal2FA = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
        error: "Unauthorized",
      });
    }

    const validationResult = verify2FASchema.safeParse(req.body);
    if (!validationResult.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
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
    logger.error(error, "[2FA] Error verifying withdrawal 2FA");
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error", {
      error: "Internal server error",
    });
  }
};
