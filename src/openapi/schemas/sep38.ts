/**
 * SEP-38 (Quotes & Price Streams) — Zod schema definitions.
 *
 * These schemas serve dual purpose:
 *  1. Runtime request validation inside the SEP-38 router.
 *  2. Auto-generated OpenAPI 3.0 component definitions via zod-to-openapi.
 */

import { z } from 'zod';
import { registry } from '../registry';

// ─── Reusable primitives ──────────────────────────────────────────────────────

/** SEP-38 asset identifier — e.g. "iso4217:XAF" or "stellar:XLM" */
export const Sep38AssetSchema = z
  .string()
  .min(1)
  .openapi({
    example: 'iso4217:XAF',
    description:
      'SEP-38 asset identifier. Format: "iso4217:<CODE>" for fiat, ' +
      '"stellar:XLM" for native XLM, or "stellar:<CODE>:<ISSUER>" for Stellar assets.',
  });

/** Numeric string with up to 7 decimal places */
export const AmountStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Must be a positive decimal with up to 7 decimal places')
  .openapi({ example: '10000.0000000' });

// ─── Info ─────────────────────────────────────────────────────────────────────

export const Sep38AssetPairSchema = registry.register(
  'Sep38AssetPair',
  z
    .object({
      sell_asset: Sep38AssetSchema,
      buy_asset: Sep38AssetSchema,
    })
    .openapi('Sep38AssetPair', {
      description: 'A supported sell → buy asset pair.',
    }),
);

export const Sep38InfoResponseSchema = registry.register(
  'Sep38InfoResponse',
  z
    .object({
      assets: z.array(Sep38AssetPairSchema).openapi({
        description: 'All supported asset conversion pairs.',
      }),
    })
    .openapi('Sep38InfoResponse'),
);

// ─── Prices / Price ───────────────────────────────────────────────────────────

/** Query parameters shared by GET /prices and GET /price */
export const Sep38PriceQuerySchema = z.object({
  sell_asset: Sep38AssetSchema,
  buy_asset: Sep38AssetSchema,
});

export const Sep38PriceResponseSchema = registry.register(
  'Sep38PriceResponse',
  z
    .object({
      sell_asset: Sep38AssetSchema,
      buy_asset: Sep38AssetSchema,
      price: z.string().openapi({ example: '650.1234567', description: 'Units of buy_asset per 1 unit of sell_asset.' }),
      fee_percent: z.string().openapi({ example: '0.50', description: 'Percentage fee applied to this conversion.' }),
      fee_fixed: z.string().openapi({ example: '0.0000000', description: 'Fixed fee in sell_asset units.' }),
    })
    .openapi('Sep38PriceResponse', {
      description: 'Indicative or firm price for an asset pair.',
    }),
);

// ─── Quote (POST) ─────────────────────────────────────────────────────────────

export const Sep38QuoteRequestSchema = registry.register(
  'Sep38QuoteRequest',
  z
    .object({
      sell_asset: Sep38AssetSchema,
      buy_asset: Sep38AssetSchema,
      sell_amount: z
        .string()
        .regex(/^\d+(\.\d{1,7})?$/, 'sell_amount must be a positive decimal')
        .optional()
        .openapi({ example: '10000', description: 'Amount to sell. Provide exactly one of sell_amount or buy_amount.' }),
      buy_amount: z
        .string()
        .regex(/^\d+(\.\d{1,7})?$/, 'buy_amount must be a positive decimal')
        .optional()
        .openapi({ example: '15.3000000', description: 'Amount to receive. Provide exactly one of sell_amount or buy_amount.' }),
      ttl: z
        .number()
        .int()
        .positive()
        .max(300)
        .optional()
        .openapi({ example: 60, description: 'Quote lifetime in seconds (1–300). Defaults to 60.' }),
    })
    .refine((d) => !!(d.sell_amount || d.buy_amount), {
      message: 'Exactly one of sell_amount or buy_amount must be provided.',
    })
    .openapi('Sep38QuoteRequest'),
);

// ─── Quote (GET/POST response) ────────────────────────────────────────────────

export const Sep38QuoteSchema = registry.register(
  'Sep38Quote',
  z
    .object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
      expires_at: z.string().datetime().openapi({ example: '2024-04-25T10:01:00.000Z' }),
      sell_asset: Sep38AssetSchema,
      buy_asset: Sep38AssetSchema,
      sell_amount: AmountStringSchema,
      buy_amount: AmountStringSchema,
      price: z.string().openapi({ example: '650.1234567' }),
      fee_percent: z.string().openapi({ example: '0.50' }),
      fee_fixed: z.string().openapi({ example: '0.0000000' }),
      created_at: z.string().datetime().openapi({ example: '2024-04-25T10:00:00.000Z' }),
    })
    .openapi('Sep38Quote', {
      description: 'A firm, time-locked SEP-38 quote.',
    }),
);
