/**
 * Fees domain schemas — derived from src/routes/fees.ts and src/routes/feeStrategies.ts
 */

import { z } from "zod";
import { registry } from "../registry";

// ─── Fee config ───────────────────────────────────────────────────────────────

export const CreateFeeConfigRequestSchema = registry.register(
  "CreateFeeConfigRequest",
  z
    .object({
      name: z.string().min(1).max(100).openapi({ example: "Standard Fee" }),
      description: z
        .string()
        .optional()
        .openapi({ example: "Default fee for all users" }),
      feePercentage: z.number().min(0).max(100).openapi({ example: 1.5 }),
      feeMinimum: z.number().min(0).openapi({ example: 50 }),
      feeMaximum: z.number().min(0).openapi({ example: 5000 }),
    })
    .openapi("CreateFeeConfigRequest"),
);

export const FeeEstimateRequestSchema = registry.register(
  "FeeEstimateRequest",
  z
    .object({
      amount: z.number().positive().openapi({ example: 10000 }),
      userId: z
        .string()
        .uuid()
        .optional()
        .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
      transactionType: z
        .enum(["send", "deposit", "withdraw", "payment"])
        .optional()
        .openapi({ example: "deposit" }),
    })
    .openapi("FeeEstimateRequest"),
);

export const FeeEstimateResponseSchema = registry.register(
  "FeeEstimateResponse",
  z
    .object({
      amount: z.number().openapi({ example: 10000 }),
      fee: z.number().openapi({ example: 150 }),
      netAmount: z.number().openapi({ example: 9850 }),
      feePercentage: z.number().openapi({ example: 1.5 }),
    })
    .openapi("FeeEstimateResponse"),
);

// ─── Fee strategy ─────────────────────────────────────────────────────────────

export const VolumeTierSchema = registry.register(
  "VolumeTier",
  z
    .object({
      minAmount: z.number().min(0).openapi({ example: 0 }),
      maxAmount: z.number().positive().nullable().openapi({ example: 100000 }),
      feePercentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .openapi({ example: 2.0 }),
      flatAmount: z.number().min(0).optional().openapi({ example: 100 }),
    })
    .openapi("VolumeTier"),
);

export const CreateFeeStrategyRequestSchema = registry.register(
  "CreateFeeStrategyRequest",
  z
    .object({
      name: z.string().min(1).max(100).openapi({ example: "Weekend Discount" }),
      description: z
        .string()
        .optional()
        .openapi({ example: "Reduced fees on weekends" }),
      strategyType: z
        .enum(["flat", "percentage", "time_based", "volume_based"])
        .openapi({ example: "percentage" }),
      scope: z
        .enum(["user", "provider", "global"])
        .openapi({ example: "global" }),
      feePercentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .openapi({ example: 1.0 }),
      flatAmount: z.number().min(0).optional().openapi({ example: 50 }),
      volumeTiers: z.array(VolumeTierSchema).optional(),
    })
    .openapi("CreateFeeStrategyRequest"),
);
