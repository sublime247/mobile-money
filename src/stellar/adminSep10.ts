import { Router, Request, Response } from "express";
import { Sep10Service, getSep10Config, Sep10ChallengeResponse, Sep10TokenResponse } from "./sep10";
import { adminStellarKeyModel } from "../models/adminStellarKey";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/**
 * Admin SEP-10 Authentication Service
 *
 * Extends the standard SEP-10 service to provide admin-specific authentication
 * using whitelisted Stellar public keys.
 */

export interface AdminSep10TokenResponse extends Sep10TokenResponse {
  isAdmin: boolean;
  adminKeyId?: string;
}

export class AdminSep10Service extends Sep10Service {
  constructor() {
    super(getSep10Config());
  }

  /**
   * Verify a signed challenge transaction and check admin authorization
   *
   * @param transactionXDR - The signed transaction XDR
   * @param clientAccountID - Optional client account ID for validation
   * @returns Admin token response with admin status
   */
  async verifyAdminChallenge(
    transactionXDR: string,
    clientAccountID?: string
  ): Promise<AdminSep10TokenResponse> {
    // First verify the standard SEP-10 challenge (now async)
    const baseToken = await this.verifyChallenge(transactionXDR, clientAccountID);

    // Extract the client public key from the transaction
    const transaction = require("stellar-sdk").TransactionBuilder.fromXDR(
      transactionXDR,
      this.config.networkPassphrase
    ) as any;

    const clientPublicKey = transaction.operations[0].source || transaction.source;

    // Check if this public key is authorized for admin access
    const isAdmin = await adminStellarKeyModel.isAdminKey(clientPublicKey);
    const adminKey = isAdmin ? await adminStellarKeyModel.findByPublicKey(clientPublicKey) : null;

    return {
      ...baseToken,
      isAdmin,
      adminKeyId: adminKey?.id,
    };
  }
}

// Singleton instance
let adminSep10Service: AdminSep10Service | null = null;

export function getAdminSep10Service(): AdminSep10Service {
  if (!adminSep10Service) {
    adminSep10Service = new AdminSep10Service();
  }
  return adminSep10Service;
}

/**
 * Admin SEP-10 Router
 *
 * Provides endpoints for admin authentication via Stellar wallets
 */
export function createAdminSep10Router(): Router {
  const router = Router();
  const service = getAdminSep10Service();

  /**
   * GET /admin/auth/challenge
   *
   * Generate a SEP-10 challenge transaction for admin authentication
   */
router.get("/challenge", (req: Request, res: Response) => {
  try {
    const { account } = req.query;

    if (!account || typeof account !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, "account parameter is required", {
        error: "account parameter is required",
      });
    }

    // Generate the challenge transaction
    const challenge: Sep10ChallengeResponse = service.generateChallenge(account);

    return res.json(challenge);
  } catch (error) {
    console.error("[Admin SEP-10] Error generating challenge:", error);

    if (error instanceof Error) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
        error: error.message,
      });
    }

    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate challenge transaction");
  }
});

  /**
   * POST /admin/auth/verify
   *
   * Verify a signed challenge transaction and authenticate admin
   */
 router.post("/verify", async (req: Request, res: Response) => {
  try {
    const { transaction } = req.body;

    if (!transaction || typeof transaction !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, "transaction parameter is required", {
        error: "transaction parameter is required",
      });
    }

    // Verify the challenge and check admin authorization
    const tokenResponse = await service.verifyAdminChallenge(transaction);

    if (!tokenResponse.isAdmin) {
      throw createError(ERROR_CODES.FORBIDDEN, "Unauthorized", {
        error: "Unauthorized",
        message: "The provided Stellar public key is not authorized for admin access",
      });
    }

    return res.json(tokenResponse);
  } catch (error) {
    console.error("[Admin SEP-10] Error verifying challenge:", error);

    if (error instanceof Error) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
        error: error.message,
      });
    }

    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to verify challenge transaction");
  }
});

  /**
   * GET /admin/auth/health
   *
   * Health check endpoint for admin SEP-10 service
   */
  router.get("/health", (req: Request, res: Response) => {
    return res.json({
      status: "ok",
      service: "Admin SEP-10 Authentication",
      server_key: service.getServerPublicKey(),
    });
  });

  return router;
}