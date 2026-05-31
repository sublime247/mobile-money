/**
 * Price history domain schemas — derived from src/routes/priceHistory.ts
 */

import { z } from "zod";
import { registry } from "../registry";

export const PriceSnapshotSchema = registry.register(
  "PriceSnapshot",
  z
    .object({
      id: z.string().openapi({ example: "1" }),
      base: z.string().openapi({ example: "XLM" }),
      quote: z.string().openapi({ example: "USD" }),
      price: z.number().openapi({ example: 0.1234 }),
      recordedAt: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-25T10:00:00.000Z" }),
    })
    .openapi("PriceSnapshot"),
);

export const PriceListResponseSchema = registry.register(
  "PriceListResponse",
  z
    .object({
      data: z.array(PriceSnapshotSchema),
      count: z.number().int().openapi({ example: 48 }),
    })
    .openapi("PriceListResponse"),
);
