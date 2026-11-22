import { z } from "zod";

/**
 * SEP-6 Standard Field Schema for deposit/withdraw instructions
 */
export const sep6FieldSchema = z.object({
  description: z.string().optional(),
  optional: z.boolean().optional(),
  choices: z.array(z.string()).optional(),
});

/**
 * SEP-6 Deposit Asset Configuration Schema
 * min_amount, max_amount, fee_fixed, and fee_percent are required on every asset
 */
export const sep6DepositAssetSchema = z
  .object({
    enabled: z.boolean(),
    authentication_required: z.boolean().optional(),
    min_amount: z
      .number({ required_error: "min_amount is required" })
      .nonnegative("min_amount must be greater than or equal to 0"),
    max_amount: z
      .number({ required_error: "max_amount is required" })
      .positive("max_amount must be greater than 0"),
    fee_fixed: z
      .number({ required_error: "fee_fixed is required" })
      .nonnegative("fee_fixed must be greater than or equal to 0"),
    fee_percent: z
      .number({ required_error: "fee_percent is required" })
      .min(0, "fee_percent must be >= 0")
      .max(100, "fee_percent cannot exceed 100"),
    fields: z.record(z.string(), sep6FieldSchema).optional(),
  })
  .refine((data) => data.max_amount >= data.min_amount, {
    message: "max_amount must be greater than or equal to min_amount",
    path: ["max_amount"],
  });

/**
 * SEP-6 Withdraw Type Schema
 */
export const sep6WithdrawTypeSchema = z.object({
  fields: z.record(z.string(), sep6FieldSchema).optional(),
});

/**
 * SEP-6 Withdraw Asset Configuration Schema
 * min_amount, max_amount, fee_fixed, and fee_percent are required on every asset
 */
export const sep6WithdrawAssetSchema = z
  .object({
    enabled: z.boolean(),
    authentication_required: z.boolean().optional(),
    min_amount: z
      .number({ required_error: "min_amount is required" })
      .nonnegative("min_amount must be greater than or equal to 0"),
    max_amount: z
      .number({ required_error: "max_amount is required" })
      .positive("max_amount must be greater than 0"),
    fee_fixed: z
      .number({ required_error: "fee_fixed is required" })
      .nonnegative("fee_fixed must be greater than or equal to 0"),
    fee_percent: z
      .number({ required_error: "fee_percent is required" })
      .min(0, "fee_percent must be >= 0")
      .max(100, "fee_percent cannot exceed 100"),
    types: z.record(z.string(), sep6WithdrawTypeSchema).optional(),
  })
  .refine((data) => data.max_amount >= data.min_amount, {
    message: "max_amount must be greater than or equal to min_amount",
    path: ["max_amount"],
  });

/**
 * SEP-6 Endpoint Capability Flag Schemas
 */
export const sep6FeeCapabilitySchema = z.object({
  enabled: z.boolean(),
  description: z.string().optional(),
});

export const sep6TransactionsCapabilitySchema = z.object({
  enabled: z.boolean(),
  authentication_required: z.boolean().optional(),
});

export const sep6TransactionCapabilitySchema = z.object({
  enabled: z.boolean(),
  authentication_required: z.boolean().optional(),
});

export const sep6FeaturesSchema = z.object({
  account_creation: z.boolean().optional(),
  claimable_balances: z.boolean().optional(),
});

/**
 * SEP-6 GET /info Outgoing Response Schema
 */
export const sep6InfoResponseSchema = z.object({
  deposit: z.record(z.string(), sep6DepositAssetSchema),
  withdraw: z.record(z.string(), sep6WithdrawAssetSchema),
  fee: sep6FeeCapabilitySchema.optional(),
  transactions: sep6TransactionsCapabilitySchema.optional(),
  transaction: sep6TransactionCapabilitySchema.optional(),
  features: sep6FeaturesSchema.optional(),
});

export type Sep6DepositAsset = z.infer<typeof sep6DepositAssetSchema>;
export type Sep6WithdrawAsset = z.infer<typeof sep6WithdrawAssetSchema>;
export type Sep6InfoResponse = z.infer<typeof sep6InfoResponseSchema>;

/**
 * Validates SEP-6 /info response object against schema.
 * Throws ZodError on failure.
 */
export function validateSep6InfoResponse(data: unknown): Sep6InfoResponse {
  return sep6InfoResponseSchema.parse(data);
}
