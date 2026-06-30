/**
 * OpenAPI path registrations for /api/vaults/* and /api/v1/vaults/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  CreateVaultRequestSchema,
  UpdateVaultRequestSchema,
  VaultTransferRequestSchema,
  VaultResponseSchema,
  VaultListResponseSchema,
} from "../schemas/vaults";
import { ErrorResponseSchema, PaginationSchema } from "../schemas/common";

const TAG = "Vaults";
const SECURITY = [{ bearerAuth: [] }];

registry.registerPath({
  method: "post",
  path: "/api/v1/vaults",
  tags: [TAG],
  summary: "Create a new savings vault",
  security: SECURITY,
  request: {
    body: {
      content: { "application/json": { schema: CreateVaultRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Vault created",
      content: { "application/json": { schema: VaultResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Vault name already exists",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/vaults",
  tags: [TAG],
  summary: "List all vaults for the authenticated user",
  security: SECURITY,
  request: {
    query: z.object({
      includeInactive: z
        .enum(["true", "false"])
        .optional()
        .openapi({ example: "false" }),
    }),
  },
  responses: {
    200: {
      description: "List of vaults",
      content: { "application/json": { schema: VaultListResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/vaults/balance-summary",
  tags: [TAG],
  summary: "Get aggregated balance summary across all vaults",
  security: SECURITY,
  responses: {
    200: {
      description: "Balance summary",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              totalBalance: z.string().openapi({ example: "1500.00" }),
              vaultCount: z.number().int().openapi({ example: 3 }),
            }),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/vaults/{vaultId}",
  tags: [TAG],
  summary: "Get a vault by ID",
  security: SECURITY,
  request: {
    params: z.object({
      vaultId: z
        .string()
        .uuid()
        .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    }),
  },
  responses: {
    200: {
      description: "Vault details",
      content: { "application/json": { schema: VaultResponseSchema } },
    },
    403: {
      description: "Access denied",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Vault not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/vaults/{vaultId}",
  tags: [TAG],
  summary: "Update a vault",
  security: SECURITY,
  request: {
    params: z.object({ vaultId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: UpdateVaultRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Vault updated",
      content: { "application/json": { schema: VaultResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Access denied",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Vault not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/vaults/{vaultId}",
  tags: [TAG],
  summary: "Delete a vault",
  security: SECURITY,
  request: {
    params: z.object({ vaultId: z.string().uuid() }),
  },
  responses: {
    200: { description: "Vault deleted" },
    400: {
      description: "Cannot delete vault (non-zero balance)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Access denied",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Vault not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/vaults/{vaultId}/transfer",
  tags: [TAG],
  summary: "Deposit or withdraw funds from a vault",
  security: SECURITY,
  request: {
    params: z.object({ vaultId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: VaultTransferRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Transfer completed",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              vault: z.record(z.string(), z.unknown()),
              transaction: z.record(z.string(), z.unknown()),
            }),
          }),
        },
      },
    },
    400: {
      description: "Insufficient funds or validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Access denied",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Vault not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/vaults/{vaultId}/transactions",
  tags: [TAG],
  summary: "List transactions for a vault",
  security: SECURITY,
  request: {
    params: z.object({ vaultId: z.string().uuid() }),
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .openapi({ example: 50 }),
      offset: z.coerce.number().int().min(0).optional().openapi({ example: 0 }),
    }),
  },
  responses: {
    200: {
      description: "Vault transaction history",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.array(z.record(z.string(), z.unknown())),
            pagination: PaginationSchema,
          }),
        },
      },
    },
    403: {
      description: "Access denied",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Vault not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
