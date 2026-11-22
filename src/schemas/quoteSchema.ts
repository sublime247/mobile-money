/**
 * Zod schema definitions for the /api/v1/quotes endpoint.
 * Issue #2283
 *
 * Enforces:
 *   - Strict field presence (source_asset, destination_asset, amount required)
 *   - No extra / unexpected fields (strip mode disabled — unknown keys rejected)
 *   - Business-logic constraints (positive amount, valid ISO 4217 currency codes)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Supported asset / currency codes
// ---------------------------------------------------------------------------

/**
 * ISO 4217 fiat currency codes accepted by the platform.
 * Extend this list as new corridors are onboarded.
 */
export const SUPPORTED_FIAT_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "XAF",
  "NGN",
  "KES",
  "GHS",
  "TZS",
  "ZMW",
  "RWF",
  "MWK",
  "UGX",
  "XOF",
  "ZAR",
] as const;

/**
 * Stellar / crypto asset codes accepted as source or destination.
 */
export const SUPPORTED_STELLAR_ASSETS = [
  "USDC",
  "XLM",
  "EURC",
] as const;

/** Union of all accepted asset codes (fiat + stellar). */
export const ALL_ASSET_CODES = [
  ...SUPPORTED_FIAT_CURRENCIES,
  ...SUPPORTED_STELLAR_ASSETS,
] as const;

export type AssetCode = (typeof ALL_ASSET_CODES)[number];

// ---------------------------------------------------------------------------
// QuoteCreateRequest schema
// ---------------------------------------------------------------------------

/**
 * Strict Zod schema for POST /api/v1/quotes request body.
 *
 * Validation rules:
 *   source_asset        — required, must be a recognised asset code
 *   destination_asset   — required, must be a recognised asset code,
 *                         must differ from source_asset
 *   amount              — required, finite positive number (rejects 0, negative,
 *                         NaN, Infinity, and strings)
 *
 * Unknown / extra fields are rejected (strict mode) to prevent parameter
 * injection attacks.
 */
export const quoteCreateSchema = z
  .object({
    source_asset: z.enum(ALL_ASSET_CODES, {
      message: `source_asset must be one of: ${ALL_ASSET_CODES.join(", ")}`,
    }),

    destination_asset: z.enum(ALL_ASSET_CODES, {
      message: `destination_asset must be one of: ${ALL_ASSET_CODES.join(", ")}`,
    }),

    amount: z
      .number({
        message: "amount must be a number",
      })
      .positive({ message: "amount must be a positive number" })
      .finite({ message: "amount must be a finite number" }),
  })
  // Reject any unknown fields — prevents parameter injection
  .strict({ message: "Request body contains unexpected fields" })
  // Cross-field rule: source and destination must differ
  .refine((data) => data.source_asset !== data.destination_asset, {
    message: "source_asset and destination_asset must be different",
    path: ["destination_asset"],
  });

/** Inferred TypeScript type for a validated quote creation request. */
export type QuoteCreateRequest = z.infer<typeof quoteCreateSchema>;

// ---------------------------------------------------------------------------
// Zod error → structured validation error format
// ---------------------------------------------------------------------------

export interface ValidationFieldError {
  field: string;
  message: string;
}

/**
 * Flatten a ZodError into a simple array of `{ field, message }` objects
 * suitable for HTTP 400 responses.
 */
export function formatZodErrors(error: z.ZodError): ValidationFieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "_root",
    message: issue.message,
  }));
}
