import { Request, Response } from "express";
import { AssetIssuanceService } from "../../services/stellar/issuanceService";
import { AnchoredAssetModel } from "../../models/anchoredAsset";
import { logger } from "../../utils/logger";
import { z } from "zod";

const IssueAssetSchema = z.object({
  assetCode: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[a-zA-Z0-9]+$/),
  limit: z.string().regex(/^\d+(\.\d+)?$/),
  name: z.string().min(1),
  description: z.string().optional(),
});

export class AssetWizardController {
  private issuanceService = new AssetIssuanceService();
  private assetModel = new AnchoredAssetModel();

  /**
   * POST /api/admin/assets/issue
   * Orchestrates asset issuance on Stellar and saves to DB.
   */
  issueAsset = async (req: Request, res: Response) => {
    try {
      const { assetCode, limit, name, description } = IssueAssetSchema.parse(
        req.body,
      );

      // 1. Check if asset already exists in our DB
      const existing = await this.assetModel.findByCode(assetCode);
      if (existing) {
        return res
          .status(400)
          .json({ error: `Asset code ${assetCode} already exists.` });
      }

      // 2. Perform Stellar Issuance
      const setupResult = await this.issuanceService.setupAnchoredAsset(
        assetCode,
        limit,
      );

      // 3. Save to Database
      const assetId = await this.assetModel.insert({
        assetCode,
        issuerPublicKey: setupResult.issuerPublicKey,
        issuerSecretKey: setupResult.issuerSecretKeyEncrypted,
        distributionPublicKey: setupResult.distributionPublicKey,
        distributionSecretKey: setupResult.distributionSecretKeyEncrypted,
        issuanceLimit: limit,
        status: "active",
        metadata: {
          name,
          description,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: assetId,
          assetCode,
          issuerPublicKey: setupResult.issuerPublicKey,
          distributionPublicKey: setupResult.distributionPublicKey,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Validation failed", details: error.issues });
      }
      logger.error("[asset-wizard] Issuance failed:", error);
      res
        .status(500)
        .json({ error: "Asset issuance failed. Please check logs." });
    }
  };

  /**
   * GET /api/admin/assets
   * List all anchored assets.
   */
  listAssets = async (_req: Request, res: Response) => {
    try {
      const assets = await this.assetModel.findAll();
      // Sanitize: don't return encrypted secrets
      const sanitized = assets.map(
        ({ issuerSecretKey, distributionSecretKey, ...rest }) => rest,
      );
      res.json({ success: true, data: sanitized });
    } catch (error) {
      logger.error("[asset-wizard] List failed:", error);
      res.status(500).json({ error: "Failed to list assets." });
    }
  };
}
