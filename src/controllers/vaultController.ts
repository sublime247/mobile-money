import { Request, Response } from "express";
import { z } from "zod";
import { VaultModel, CreateVaultInput, VaultTransferInput } from "../models/vault";
import { lockManager, LockKeys } from "../utils/lock";

const vaultModel = new VaultModel();

// Validation schemas
const createVaultSchema = z.object({
  name: z.string().min(1, "Vault name is required").max(100, "Vault name too long"),
  description: z.string().max(1000, "Description too long").optional(),
  targetAmount: z.string().regex(/^\d+(\.\d{1,7})?$/, "Invalid target amount").optional(),
});

const transferFundsSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/, "Invalid amount format"),
  type: z.enum(["deposit", "withdraw"], { message: "Type must be deposit or withdraw" }),
  description: z.string().max(500, "Description too long").optional(),
});

const updateVaultSchema = z.object({
  name: z.string().min(1, "Vault name is required").max(100, "Vault name too long").optional(),
  description: z.string().max(1000, "Description too long").optional(),
  targetAmount: z.string().regex(/^\d+(\.\d{1,7})?$/, "Invalid target amount").optional(),
  isActive: z.boolean().optional(),
});

export const createVault = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const validatedData = createVaultSchema.parse(req.body);

    // Check for duplicate vault name
    const existing = await vaultModel.findByUserAndName(userId, validatedData.name);
    if (existing) {
      return res.status(409).json({ 
        error: "Vault name already exists",
        message: "You already have a vault with this name" 
      });
    }

    const vault = await vaultModel.create({
      userId,
      name: validatedData.name,
      description: validatedData.description || "",
      targetAmount: validatedData.targetAmount || null,
    });

    res.status(201).json({
      success: true,
      data: vault,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation error",
        details: error.issues.map((e: z.ZodIssue) => e.message).join(", "),
      });
    }

    console.error("Create vault error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to create vault",
    });
  }
};

export const getUserVaults = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const includeInactive = req.query.includeInactive === "true";
    const vaults = await vaultModel.findByUserId(userId, !includeInactive);

    res.json({
      success: true,
      data: vaults,
    });
  } catch (error: any) {
    console.error("Get user vaults error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to retrieve vaults",
    });
  }
};

export const getVaultById = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { vaultId } = req.params;
    const vault = await vaultModel.findById(vaultId);

    if (!vault) {
      return res.status(404).json({ error: "Vault not found" });
    }

    // Ensure user owns the vault
    if (vault.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json({
      success: true,
      data: vault,
    });
  } catch (error: any) {
    console.error("Get vault error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to retrieve vault",
    });
  }
};

export const updateVault = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { vaultId } = req.params;
    const validatedData = updateVaultSchema.parse(req.body);

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      return res.status(404).json({ error: "Vault not found" });
    }
    if (vault.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Check for name conflicts if name is being updated
    if (validatedData.name && validatedData.name !== vault.name) {
      const existing = await vaultModel.findByUserAndName(userId, validatedData.name);
      if (existing) {
        return res.status(409).json({ 
          error: "Vault name already exists",
          message: "You already have a vault with this name" 
        });
      }
    }

    const updatedVault = await vaultModel.updateVault(vaultId, validatedData);

    res.json({
      success: true,
      data: updatedVault,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation error",
        details: error.issues.map((e: z.ZodIssue) => e.message).join(", "),
      });
    }

    console.error("Update vault error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to update vault",
    });
  }
};

export const deleteVault = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { vaultId } = req.params;

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      return res.status(404).json({ error: "Vault not found" });
    }
    if (vault.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const deleted = await vaultModel.delete(vaultId);
    if (!deleted) {
      return res.status(400).json({ 
        error: "Cannot delete vault",
        message: "Vault may have a non-zero balance" 
      });
    }

    res.json({
      success: true,
      message: "Vault deleted successfully",
    });
  } catch (error: any) {
    console.error("Delete vault error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to delete vault",
    });
  }
};

export const transferFunds = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { vaultId } = req.params;
    const validatedData = transferFundsSchema.parse(req.body);

    // Validate amount
    const amount = parseFloat(validatedData.amount);
    if (amount <= 0) {
      return res.status(400).json({ 
        error: "Invalid amount",
        message: "Amount must be greater than 0" 
      });
    }

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      return res.status(404).json({ error: "Vault not found" });
    }
    if (vault.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Use distributed lock to prevent race conditions
    const lockKey = `vault-transfer:${userId}:${vaultId}`;
    
    const result = await lockManager.withLock(lockKey, async () => {
      return await vaultModel.transferFunds(
        userId,
        vaultId,
        validatedData.amount,
        validatedData.type,
        validatedData.description,
      );
    }, 10000); // 10 second lock

    res.json({
      success: true,
      data: {
        vault: result.vault,
        transaction: result.vaultTransaction,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation error",
        details: error.issues.map((e: z.ZodIssue) => e.message).join(", "),
      });
    }

    console.error("Transfer funds error:", error);
    
    if (error.message.includes("Insufficient")) {
      return res.status(400).json({
        error: "Insufficient funds",
        message: error.message,
      });
    }

    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to transfer funds",
    });
  }
};

export const getVaultTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { vaultId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Check vault exists and user owns it
    const vault = await vaultModel.findById(vaultId);
    if (!vault) {
      return res.status(404).json({ error: "Vault not found" });
    }
    if (vault.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const transactions = await vaultModel.getVaultTransactions(vaultId, limit, offset);

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
    console.error("Get vault transactions error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to retrieve vault transactions",
    });
  }
};

export const getUserBalanceSummary = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const summary = await vaultModel.getUserBalanceSummary(userId);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error: any) {
    console.error("Get balance summary error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to retrieve balance summary",
    });
  }
};