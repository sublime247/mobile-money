import { Request, Response, Router } from "express";
import { requireAuth } from "../middleware/auth";
import { optimizeProfileImage, upload } from "../middleware/upload";
import { uploadToS3 } from "../services/s3Upload";
import { pool } from "../config/database";
import {
  getWithdrawal2FASettings,
  updateMandatory2FAWithdrawals,
  verifyWithdrawal2FA,
} from "../controllers/twoFactorWithdrawalController";

const router = Router();

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
        return res.status(400).json({ error: "No image provided" });
      }

      const uploadResult = await uploadToS3({
        userId,
        file,
        metadata: { type: "profile_picture" },
      });

      if (!uploadResult.success) {
        return res.status(500).json({ error: uploadResult.error });
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
      console.error("Controller upload error:", error);
      res.status(500).json({ error: "Internal server error during upload" });
    }
  },
);

// 2FA Withdrawal Settings Routes
router.get("/2fa/withdrawals", requireAuth, getWithdrawal2FASettings);
router.put("/2fa/withdrawals", requireAuth, updateMandatory2FAWithdrawals);
router.post("/2fa/withdrawals/verify", requireAuth, verifyWithdrawal2FA);

export { router as userRoutes };
