/**
 * Shared / reusable OpenAPI component schemas.
 */

import { z } from "zod";
import { registry } from "../registry";

// ─── Error response ───────────────────────────────────────────────────────────

export const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z
    .object({
      error: z.string().openapi({ example: "Validation failed" }),
      message: z
        .string()
        .optional()
        .openapi({ example: "Amount must be a positive number" }),
    })
    .openapi("ErrorResponse", { description: "Standard error envelope" }),
);

// ─── Pagination ───────────────────────────────────────────────────────────────

export const PaginationSchema = registry.register(
  "Pagination",
  z
    .object({
      limit: z.number().int().openapi({ example: 50 }),
      offset: z.number().int().openapi({ example: 0 }),
      hasMore: z.boolean().openapi({ example: false }),
    })
    .openapi("Pagination"),
);

// ─── Security scheme ─────────────────────────────────────────────────────────

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});
