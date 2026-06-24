import logger from "../utils/logger";
import { Request, Response } from "express";
import { redisClient } from "../config/redis";
import { RefreshTokenFamilyModel } from "../models/refreshTokenFamily";

const refreshTokenLabel = (lbl: string) => {
  return `refresh_token:${lbl}`;
};

const refreshTokenFamilyModel = new RefreshTokenFamilyModel();
export const tokenController = {
  // List all active refresh tokens for current user
  findAll: async (req: Request, res: Response) => {
    const userId = (req as any).jwtUser.userId;
    const { family_id } = req.params;

    try {
      const rows = await refreshTokenFamilyModel.findAllActive(
        userId,
        family_id,
      );

      res.json({
        success: true,
        data: { tokens: rows },
      });
    } catch (err: any) {
      logger.error(err);

      res.status(500).json({ success: false, error: err.message });
    }
  },
  // Revoke specific token
  revoke: async (req: Request, res: Response) => {
    const { token_id, family_id } = req.params;
    const userId = (req as any).jwtUser.userId;

    try {
      const { data } = await refreshTokenFamilyModel.revokeFamily(
        family_id,
        userId,
        token_id,
      );

      // Clear from Redis
      await redisClient.del(refreshTokenLabel(data.familyId));

      res.json({
        success: true,
        message: "Token revoked successfully",
      });
    } catch (err: any) {
      logger.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
  // Revoke all active tokens
  revokeAll: async (req: Request, res: Response) => {
    const userId = (req as any).jwtUser.userId;
    const { family_id } = req.params;

    try {
      const { data } = await refreshTokenFamilyModel.revokeAll(
        userId,
        family_id,
      );

      // Clear all from Redis
      for (const row of data.tokenResult.rows) {
        await redisClient.del(refreshTokenLabel(row.family_id));
      }

      res.json({
        success: true,
        message: `Revoked ${data.tokenResult.rows.length} token(s)`,
        revokedCount: data.tokenResult.rows.length,
      });
    } catch (err: any) {
      logger.error("Error revoking all tokens:", err);

      res.status(500).json({ success: false, error: err.message });
    }
  },
  // Purged expired tokens
  purgeExpired: async (req: Request, res: Response) => {
    try {
      const { data } = await refreshTokenFamilyModel.purgeExpired();

      // Clear from Redis
      for (const row of data.expiredTokenResult.rows) {
        await redisClient.del(refreshTokenLabel(row.token_jti));
      }

      res.json({
        success: true,
        message: "Purge completed",
        purgedCount: data.purgedCount,
      });
    } catch (err: any) {
      logger.error("Error purging tokens:", err);

      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  },
};
