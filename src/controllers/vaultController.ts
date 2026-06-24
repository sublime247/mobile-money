import logger from "../utils/logger";
import { Request, Response } from "express";
import { z } from "zod";
import {
  VaultModel,
  CreateVaultInput,
  VaultTransferInput,
} from "../models/vault";
import {
  isLockAcquisitionError,
  lockManager,
  LockKeys,
} from "../utils/lock";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

const vaultModel = new VaultModel();

// Validation schemas
const createVaultSchema = z.object({
  name: z
    .string()
    .min(1, "Vault name is required")
    .max(100, "Vault name too long"),
  description: z.string().max(1000, "Description too long").optional(),
  targetAmount: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, "Invalid target amount")
    .optional(),
});

const transferFundsSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/, "Invalid amount format"),
  type: z.enum(["deposit", "withdraw"], {
    message: "Type must be deposit or withdraw",
  }),
  description: z.string().max(500, "Description too long").optional(),
});

const updateVaultSchema = z.object({
  name: z
    .string()
    .min(1, "Vault name is required")
    .max(100, "Vault name too long")
    .optional(),
  description: z.string().max(1000, "Description too long").optional(),
  targetAmount: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, "Invalid target amount")
    .optional(),
  isActive: z.boolean().optional(),
});

export const createVault = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(
        ERROR_CODES.INVALID_CREDENTIALS,
        "Authentication is required",
        { error: "Authentication required" },
      );
    }

    const validatedData = createVaultSchema.parse(req.body);

    // Check for duplicate vault name
    const existing = await vaultModel.findByUserAndName(
      userId,
      validatedData.name,
    );
    if (existing) {
      throw createError(
        ERROR_CODES.CONFLICT,
        "You already have a vault with this name",
        { error: "Vault name already exists" },
      );
    }

    const vaultInput: CreateVaultInput = {
      userId,
      name: validatedData.name as string,
      description: validatedData.description,
      targetAmount: validatedData.targetAmount,
    };

    const vault = await vaultModel.create(vaultInput);

    res.status(201).json({
      success: true,
      data: vault,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        error: "Validation error",
        details: error.issues.map((e: z.ZodIssue) => e.message).join(", "),
      });
    }

    logger.error("Create vault error:", error);

    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      error.message || "Failed to create vault",
      { error: "Internal server error" },
    );
  }
};

export const getUserVaults = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(
        ERROR_CODES.INVALID_CREDENTIALS,
        "Authentication required",
        { error: "Authentication required" },
      );
    }

    const includeInactive = req.query.includeInactive === "true";
    const vaults = await vaultModel.findByUserId(userId, !includeInactive);

    res.json({
      success: true,
      data: vaults,
    });
  } catch (error: any) {
    logger.error("Get user vaults error:", error);

    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve vaults", {
      error: "Internal server error",
    });
  }
};

export const getVaultById = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(
        ERROR_CODES.INVALID_CREDENTIALS,
        "Authentication required",
        {
          error: "Authentication required",
        },
      );
    }

    const { vaultId } = req.params;
    const vault = await vaultModel.findById(vaultId);

    if (!vault) {
      throw createError(ERROR_CODES.NOT_FOUND, "Vault not found", {
        error: "Vault not found",
      });
    }

    // Ensure user owns the vault
    if (vault.userId !== userId) {
      throw createError(ERROR_CODES.INSUFFICIENT_PERMISSIONS, "Access denied", {
        error: "Access denied",
      });
    }

    res.json({
      success: true,
      data: vault,
    });
  } catch (error: any) {
    logger.error("Get vault error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve vault", {
      error: "Internal server error",
    });
  }
};

export const updateVault = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(
        ERROR_CODES.INVALID_CREDENTIALS,
        "Authentication required",
        {
          error: "Authentication required",
        },
      );
    }

    const { vaultId } = req.params;
    const validatedData = updateVaultSchema.parse(req.body);

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      throw createError(ERROR_CODES.RESOURCE_NOT_FOUND, "Vault not found", {
        error: "Vault not found",
      });
    }
    if (vault.userId !== userId) {
      throw createError(ERROR_CODES.INSUFFICIENT_PERMISSIONS, "Access denied", {
        error: "Access denied",
      });
    }

    // Check for name conflicts if name is being updated
    if (validatedData.name && validatedData.name !== vault.name) {
      const existing = await vaultModel.findByUserAndName(
        userId,
        validatedData.name,
      );
      if (existing) {
        throw createError(
          ERROR_CODES.CONFLICT,
          "You already have a vault with this name",
          {
            error: "Vault name already exists",
          },
        );
      }
    }

    const updatedVault = await vaultModel.updateVault(vaultId, validatedData);

    res.json({
      success: true,
      data: updatedVault,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        error: "Validation error",
        details: error.issues.map((e: z.ZodIssue) => e.message).join(", "),
      });
    }

    logger.error("Update vault error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      error.message || "Failed to update vault",
      {
        error: "Internal server error",
      },
    );
  }
};

export const deleteVault = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        error: "Authentication required",
      });
    }

    const { vaultId } = req.params;

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      throw createError(ERROR_CODES.NOT_FOUND, "Vault not found", {
        error: "Vault not found",
      });
    }
    if (vault.userId !== userId) {
      throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
        error: "Access denied",
      });
    }

    const deleted = await vaultModel.delete(vaultId);
    if (!deleted) {
      throw createError(
        ERROR_CODES.INSUFFICIENT_BALANCE,
        "Vault may have a non-zero balance",
        {
          error: "Cannot delete vault",
        },
      );
    }

    res.json({
      success: true,
      message: "Vault deleted successfully",
    });
  } catch (error: any) {
    logger.error("Delete vault error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      error.message || "Failed to delete vault",
      {
        error: "Internal server error",
      },
    );
  }
};

export const transferFunds = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Authentication required", {
        error: "Authentication required",
      });
    }

    const { vaultId } = req.params;
    const validatedData = transferFundsSchema.parse(req.body);

    // Validate amount
    const amount = parseFloat(validatedData.amount);
    if (amount <= 0) {
      throw createError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        "Amount must be greater than 0",
        {
          error: "Invalid amount",
        },
      );
    }

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      throw createError(ERROR_CODES.NOT_FOUND, "Vault not found", {
        error: "Vault not found",
      });
    }
    if (vault.userId !== userId) {
      throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
        error: "Access denied",
      });
    }

    // Use distributed lock to prevent race conditions
    const lockKey = LockKeys.vaultTransfer(userId, vaultId);

    const result = await lockManager.withLock(
      lockKey,
      async () => {
        return await vaultModel.transferFunds(
          userId,
          vaultId,
          validatedData.amount,
          validatedData.type,
          validatedData.description,
        );
      },
      10000,
    ); // 10 second lock

    res.json({
      success: true,
      data: {
        vault: result.vault,
        transaction: result.vaultTransaction,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Access denied", {
        error: "Validation error",
        details: error.issues.map((e: z.ZodIssue) => e.message).join(", "),
      });
    }

    logger.error("Transfer funds error:", error);

    if (isLockAcquisitionError(error)) {
      if (error.isContention) {
        throw createError(
          ERROR_CODES.CONFLICT,
          "Vault transfer already in progress",
          {
            error: "Vault transfer already in progress",
          },
        );
      }

      throw createError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "Vault transfer lock service unavailable",
        {
          error: "Vault transfer lock service unavailable",
        },
      );
    }

    if (error.message.includes("Insufficient")) {
      throw createError(ERROR_CODES.INSUFFICIENT_FUNDS, error.message, {
        error: "Insufficient funds",
      });
    }
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      error.message || "Failed to transfer funds",
      {
        error: "Internal server error",
      },
    );
  }
};

export const getVaultTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(
        ERROR_CODES.INVALID_CREDENTIALS,
        "Authentication required",
        {
          error: "Authentication required",
        },
      );
    }

    const { vaultId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      throw createError(ERROR_CODES.RESOURCE_NOT_FOUND, "Vault not found", {
        error: "Vault not found",
      });
    }
    if (vault.userId !== userId) {
      throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
        error: "Access denied",
      });
    }

    const transactions = await vaultModel.getVaultTransactions(
      vaultId,
      limit,
      offset,
    );

    res.json({
      success: true,
      data: transactions,
      pagination: {
        limit,
        offset,
        hasMore: transactions.length === limit,
      },
    });
  } catch (error: any) {
    logger.error("Get vault transactions error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to retrieve vault transactions",
      {
        error: "Internal server error",
      },
    );
  }
};

export const getUserBalanceSummary = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      throw createError(
        ERROR_CODES.INVALID_CREDENTIALS,
        "Authentication required",
        {
          error: "Authentication required",
        },
      );
    }

    const summary = await vaultModel.getUserBalanceSummary(userId);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error: any) {
    logger.error("Get balance summary error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to retrieve balance summary",
      {
        error: "INternal server error",
      },
    );
  }
};
