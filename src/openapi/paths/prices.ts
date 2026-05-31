/**
 * OpenAPI path registrations for /api/v1/prices/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  PriceSnapshotSchema,
  PriceListResponseSchema,
} from "../schemas/prices";
import { ErrorResponseSchema } from "../schemas/common";

const TAG = "Prices";
const CURRENCY_ENUM = z.enum(["USD", "XLM", "XAF"]);

registry.registerPath({
  method: "get",
  path: "/api/v1/prices/latest",
  tags: [TAG],
  summary: "Get the latest price snapshot for a currency pair",
  request: {
    query: z.object({
      base: CURRENCY_ENUM.openapi({ example: "XLM" }),
      quote: CURRENCY_ENUM.openapi({ example: "USD" }),
    }),
  },
  responses: {
    200: {
      description: "Latest price snapshot",
      content: { "application/json": { schema: PriceSnapshotSchema } },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No price data for this pair",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/prices/history",
  tags: [TAG],
  summary: "Get price history for a currency pair within a date range",
  request: {
    query: z.object({
      base: CURRENCY_ENUM.openapi({ example: "XLM" }),
      quote: CURRENCY_ENUM.openapi({ example: "USD" }),
      from: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-01T00:00:00.000Z" }),
      to: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-25T23:59:59.000Z" }),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .openapi({ example: 100 }),
    }),
  },
  responses: {
    200: {
      description: "Price history",
      content: { "application/json": { schema: PriceListResponseSchema } },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/prices/at",
  tags: [TAG],
  summary: "Get the price nearest to a specific point in time",
  request: {
    query: z.object({
      base: CURRENCY_ENUM.openapi({ example: "XLM" }),
      quote: CURRENCY_ENUM.openapi({ example: "USD" }),
      at: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-15T12:00:00.000Z" }),
    }),
  },
  responses: {
    200: {
      description: "Nearest price snapshot",
      content: { "application/json": { schema: PriceSnapshotSchema } },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No price data found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
