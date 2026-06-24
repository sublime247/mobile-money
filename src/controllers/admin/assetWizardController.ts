import { Request, Response } from "express";
import { AssetIssuanceService } from "../../services/stellar/issuanceService";
import { AnchoredAssetModel } from "../../models/anchoredAsset";
import logger from "../../utils/logger";
import { z } from "zod";
import { ERROR_CODES } from "../../constants/errorCodes";
import { createError } from "../../middleware/errorHandler";

const IssueAssetSchema = z.object({
  assetCode: z.string().min(1).max(12).regex(/^[a-zA-Z0-9]+$/),
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
    const { assetCode, limit, name, description } = IssueAssetSchema.parse(req.body);

    // 1. Check if asset already exists in our DB
    const existing = await this.assetModel.findByCode(assetCode);
    if (existing) {
      throw createError(ERROR_CODES.CONFLICT, `Asset code ${assetCode} already exists.`, {
        error: `Asset code ${assetCode} already exists.`,
      });
    }

    // 2. Perform Stellar Issuance
    const setupResult = await this.issuanceService.setupAnchoredAsset(assetCode, limit);

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
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
        details: error.issues,
      });
    }
    logger.error(error, "[asset-wizard] Issuance failed");
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Asset issuance failed. Please check logs.");
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
    const sanitized = assets.map(({ issuerSecretKey, distributionSecretKey, ...rest }) => rest);
    res.json({ success: true, data: sanitized });
  } catch (error) {
    logger.error(error, "[asset-wizard] List failed");
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to list assets.");
  }
};
}
