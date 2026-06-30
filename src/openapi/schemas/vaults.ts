/**
 * Vault domain schemas — derived from src/controllers/vaultController.ts
 */

import { z } from "zod";
import { registry } from "../registry";

export const CreateVaultRequestSchema = registry.register(
  "CreateVaultRequest",
  z
    .object({
      name: z.string().min(1).max(100).openapi({ example: "Emergency Fund" }),
      description: z
        .string()
        .max(1000)
        .optional()
        .openapi({ example: "Savings for emergencies" }),
      targetAmount: z
        .string()
        .regex(/^\d+(\.\d{1,7})?$/)
        .optional()
        .openapi({
          example: "1000.00",
          description: "Target savings amount (decimal string)",
        }),
    })
    .openapi("CreateVaultRequest"),
);

export const UpdateVaultRequestSchema = registry.register(
  "UpdateVaultRequest",
  z
    .object({
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .openapi({ example: "Emergency Fund v2" }),
      description: z
        .string()
        .max(1000)
        .optional()
        .openapi({ example: "Updated description" }),
      targetAmount: z
        .string()
        .regex(/^\d+(\.\d{1,7})?$/)
        .optional()
        .openapi({ example: "2000.00" }),
      isActive: z.boolean().optional().openapi({ example: true }),
    })
    .openapi("UpdateVaultRequest"),
);

export const VaultTransferRequestSchema = registry.register(
  "VaultTransferRequest",
  z
    .object({
      amount: z
        .string()
        .regex(/^\d+(\.\d{1,7})?$/)
        .openapi({
          example: "250.00",
          description: "Amount to deposit or withdraw",
        }),
      type: z.enum(["deposit", "withdraw"]).openapi({ example: "deposit" }),
      description: z
        .string()
        .max(500)
        .optional()
        .openapi({ example: "Monthly savings" }),
    })
    .openapi("VaultTransferRequest"),
);

export const VaultSchema = registry.register(
  "Vault",
  z
    .object({
      id: z
        .string()
        .uuid()
        .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
      userId: z
        .string()
        .uuid()
        .openapi({ example: "b2c3d4e5-f6a7-8901-bcde-f12345678901" }),
      name: z.string().openapi({ example: "Emergency Fund" }),
      description: z
        .string()
        .optional()
        .openapi({ example: "Savings for emergencies" }),
      balance: z.string().openapi({ example: "500.00" }),
      targetAmount: z.string().optional().openapi({ example: "1000.00" }),
      isActive: z.boolean().openapi({ example: true }),
      createdAt: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-25T10:00:00.000Z" }),
      updatedAt: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-25T10:05:00.000Z" }),
    })
    .openapi("Vault"),
);

export const VaultResponseSchema = registry.register(
  "VaultResponse",
  z
    .object({
      success: z.boolean().openapi({ example: true }),
      data: VaultSchema,
    })
    .openapi("VaultResponse"),
);

export const VaultListResponseSchema = registry.register(
  "VaultListResponse",
  z
    .object({
      success: z.boolean().openapi({ example: true }),
      data: z.array(VaultSchema),
    })
    .openapi("VaultListResponse"),
);
