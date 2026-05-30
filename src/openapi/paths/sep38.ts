/**
 * OpenAPI path registrations for /sep38/*
 *
 * All four SEP-38 endpoints are documented here:
 *  GET  /sep38/info      — List supported asset pairs
 *  GET  /sep38/prices    — Indicative price for a pair
 *  GET  /sep38/price     — Alias: single pair price
 *  POST /sep38/quote     — Create a firm, Redis-backed quote
 *  GET  /sep38/quote/:id — Retrieve a stored quote by ID
 */

import { z } from 'zod';
import { registry } from '../registry';
import {
  Sep38InfoResponseSchema,
  Sep38PriceResponseSchema,
  Sep38QuoteRequestSchema,
  Sep38QuoteSchema,
} from '../schemas/sep38';
import { ErrorResponseSchema } from '../schemas/common';

const TAG = 'SEP-38 Quotes';

// ─── GET /sep38/info ──────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/sep38/info',
  tags: [TAG],
  summary: 'List supported asset pairs',
  description:
    'Returns all asset pairs that this anchor supports for conversion. ' +
    'Wallets use this to discover which currencies they can convert between.',
  responses: {
    200: {
      description: 'Supported asset pairs',
      content: { 'application/json': { schema: Sep38InfoResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /sep38/prices ────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/sep38/prices',
  tags: [TAG],
  summary: 'Get indicative price for an asset pair',
  description:
    'Returns a live, indicative exchange rate for the requested sell_asset → buy_asset pair. ' +
    'Rates include a small market spread and may fluctuate. Use POST /sep38/quote to lock in a firm rate.',
  request: {
    query: z.object({
      sell_asset: z
        .string()
        .openapi({ example: 'iso4217:XAF', description: 'Asset to sell (SEP-38 format).' }),
      buy_asset: z
        .string()
        .openapi({
          example: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          description: 'Asset to buy (SEP-38 format).',
        }),
    }),
  },
  responses: {
    200: {
      description: 'Indicative price',
      content: { 'application/json': { schema: Sep38PriceResponseSchema } },
    },
    400: {
      description: 'Missing or unsupported asset pair',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Rate unavailable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /sep38/price ─────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/sep38/price',
  tags: [TAG],
  summary: 'Get indicative price for a single asset pair (singular alias)',
  description:
    'Identical to GET /sep38/prices — provided for clients that expect the singular form.',
  request: {
    query: z.object({
      sell_asset: z
        .string()
        .openapi({ example: 'iso4217:XAF', description: 'Asset to sell (SEP-38 format).' }),
      buy_asset: z
        .string()
        .openapi({
          example: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          description: 'Asset to buy (SEP-38 format).',
        }),
    }),
  },
  responses: {
    200: {
      description: 'Indicative price',
      content: { 'application/json': { schema: Sep38PriceResponseSchema } },
    },
    400: {
      description: 'Missing or unsupported asset pair',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Rate unavailable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /sep38/quote ────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/sep38/quote',
  tags: [TAG],
  summary: 'Create a firm quote (locked in Redis for TTL seconds)',
  description:
    'Generates a firm, time-locked quote for a specific asset conversion. ' +
    'The quote is stored in Redis and guaranteed for the duration of its TTL (default 60 s, max 300 s). ' +
    'Provide either sell_amount (amount you send) or buy_amount (amount you want to receive).',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: Sep38QuoteRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Firm quote created',
      content: { 'application/json': { schema: Sep38QuoteSchema } },
    },
    400: {
      description: 'Validation error or unsupported asset pair',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Unable to generate quote',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /sep38/quote/:id ─────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/sep38/quote/{id}',
  tags: [TAG],
  summary: 'Retrieve a stored quote by ID',
  description:
    'Looks up a previously created quote from Redis. ' +
    'Returns 404 if the quote was never created, and 410 if it has expired.',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
    }),
  },
  responses: {
    200: {
      description: 'Active quote',
      content: { 'application/json': { schema: Sep38QuoteSchema } },
    },
    400: {
      description: 'Invalid quote ID format',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Quote not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Quote has expired',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
