import logger from "../utils/logger";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { optimizeProfileImage, upload } from "../middleware/upload";
import { uploadToS3 } from "../services/s3Upload";
import { pool } from "../config/database";
import { UserModel } from "../models/users";
import {
  getWithdrawal2FASettings,
  updateMandatory2FAWithdrawals,
  verifyWithdrawal2FA,
  generateBackupCodesForUser,
  getBackupCodeStatus,
} from "../controllers/twoFactorWithdrawalController";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import {
  cleanMoMoBackupNumber,
  detectProvider,
  type CountryCode,
} from "../utils/phoneUtils";

const router = Router();
const userModel = new UserModel();

const updateDisplayNameSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "displayName is required")
    .max(120, "displayName must be 120 characters or fewer"),
});

router.post(
  "/profile-picture",
  requireAuth,
  upload.single("avatar"),
  optimizeProfileImage,
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      const userId = req.user?.id ?? "";

      if (!file) {
        throw createError(ERROR_CODES.INVALID_INPUT, "No image provided", {
          error: "No image provided",
        });
      }

      const uploadResult = await uploadToS3({
        userId,
        file,
        metadata: { type: "profile_picture" },
      });

      if (!uploadResult.success) {
        throw createError(ERROR_CODES.INTERNAL_ERROR, uploadResult.error, {
          error: uploadResult.error,
        });
      }

      const avatarUrl = uploadResult.fileUrl;

      const updateQuery = `
        UPDATE users
        SET profile_url = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, profile_url;
      `;
      await pool.query(updateQuery, [avatarUrl, userId]);

      res.status(200).json({
        message: "Profile picture uploaded successfully",
        data: { url: avatarUrl },
      });
    } catch (error) {
      logger.error("Controller upload error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Internal server error during upload",
        {
          error: "Internal server error during upload",
        },
      );
    }
  },
);

router.put(
  "/profile/display-name",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user || user.role !== "merchant") {
        throw createError(
          ERROR_CODES.FORBIDDEN,
          "Only merchants can set a display name",
          {
            error: "Only merchants can set a display name",
          },
        );
      }

      const parsed = updateDisplayNameSchema.safeParse(req.body);
      if (!parsed.success) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
          error: "Validation failed",
          details: parsed.error.issues,
        });
      }

      const userId = user.id;
      await userModel.updateDisplayName(userId, parsed.data.displayName);

      return res.status(200).json({
        message: "Merchant display name updated successfully",
        data: { displayName: parsed.data.displayName },
      });
    } catch (error) {
      logger.error("Controller display-name update error:", error);
      throw error;
    }
  },
);

// 2FA Withdrawal Settings Routes
router.get("/2fa/withdrawals", requireAuth, getWithdrawal2FASettings);
router.put("/2fa/withdrawals", requireAuth, updateMandatory2FAWithdrawals);
router.post("/2fa/withdrawals/verify", requireAuth, verifyWithdrawal2FA);

// Backup code generation routes
router.post("/2fa/backup-codes", requireAuth, generateBackupCodesForUser);
router.get("/2fa/backup-codes/status", requireAuth, getBackupCodeStatus);

const updateBackupPhoneSchema = z.object({
  backupPhoneNumber: z.string().trim().min(1, "backupPhoneNumber is required"),
  provider: z.string().trim().optional(),
  region: z.string().trim().optional(),
});

// MoMo Backup Phone Number Routes (#2085)
router.put(
  "/backup-phone",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const parsed = updateBackupPhoneSchema.safeParse(req.body);
      if (!parsed.success) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
          error: "Validation failed",
          details: parsed.error.issues,
        });
      }

      const user = await userModel.findById(userId);
      if (!user) {
        throw createError(ERROR_CODES.NOT_FOUND, "User not found", {
          error: "User not found",
        });
      }

      const cleanResult = cleanMoMoBackupNumber(
        parsed.data.backupPhoneNumber,
        user.phoneNumber,
        {
          expectedProvider: parsed.data.provider,
          defaultRegion: (parsed.data.region as CountryCode) || undefined,
        },
      );

      if (!cleanResult.valid || !cleanResult.cleanPhoneNumber) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          cleanResult.error || "Invalid backup phone number",
          {
            error: cleanResult.error || "Invalid backup phone number",
          },
        );
      }

      await userModel.updateBackupPhoneNumber(
        userId,
        cleanResult.cleanPhoneNumber,
      );

      return res.status(200).json({
        message: "Backup phone number updated successfully",
        data: {
          backupPhoneNumber: cleanResult.cleanPhoneNumber,
          provider: cleanResult.provider,
          country: cleanResult.country,
        },
      });
    } catch (error) {
      logger.error("Controller backup-phone update error:", error);
      throw error;
    }
  },
);

router.get(
  "/backup-phone",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const user = await userModel.findById(userId);
      if (!user) {
        throw createError(ERROR_CODES.NOT_FOUND, "User not found", {
          error: "User not found",
        });
      }

      const backupPhone = user.backupPhoneNumber || null;
      const provider = backupPhone ? detectProvider(backupPhone) : null;

      return res.status(200).json({
        data: {
          backupPhoneNumber: backupPhone,
          provider,
        },
      });
    } catch (error) {
      logger.error("Controller backup-phone get error:", error);
      throw error;
    }
  },
);

router.delete(
  "/backup-phone",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      await userModel.updateBackupPhoneNumber(userId, null);

      return res.status(200).json({
        message: "Backup phone number removed successfully",
      });
    } catch (error) {
      logger.error("Controller backup-phone delete error:", error);
      throw error;
    }
  },
);

export { router as userRoutes };
