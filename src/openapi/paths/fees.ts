/**
 * OpenAPI path registrations for /api/fees/* and /api/fee-strategies/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  CreateFeeConfigRequestSchema,
  FeeEstimateRequestSchema,
  FeeEstimateResponseSchema,
  CreateFeeStrategyRequestSchema,
} from "../schemas/fees";
import { ErrorResponseSchema } from "../schemas/common";

const SECURITY = [{ bearerAuth: [] }];

// ─── Fee config ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/fees/estimate",
  tags: ["Fees"],
  summary: "Estimate fee for a transaction amount",
  request: {
    body: {
      content: { "application/json": { schema: FeeEstimateRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Fee breakdown",
      content: { "application/json": { schema: FeeEstimateResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/fees",
  tags: ["Fees"],
  summary: "List all fee configurations (admin)",
  security: SECURITY,
  responses: {
    200: {
      description: "List of fee configurations",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                feePercentage: z.number(),
                feeMinimum: z.number(),
                feeMaximum: z.number(),
                isActive: z.boolean(),
              }),
            ),
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
  method: "post",
  path: "/api/fees",
  tags: ["Fees"],
  summary: "Create a fee configuration (admin)",
  security: SECURITY,
  request: {
    body: {
      content: { "application/json": { schema: CreateFeeConfigRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: { description: "Fee configuration created" },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── Fee strategies ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/fee-strategies/calculate",
  tags: ["Fee Strategies"],
  summary: "Calculate fee using the strategy engine",
  request: {
    body: {
      content: { "application/json": { schema: FeeEstimateRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Calculated fee",
      content: { "application/json": { schema: FeeEstimateResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/fee-strategies",
  tags: ["Fee Strategies"],
  summary: "List all fee strategies (admin)",
  security: SECURITY,
  responses: {
    200: { description: "List of fee strategies" },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/fee-strategies",
  tags: ["Fee Strategies"],
  summary: "Create a fee strategy (admin)",
  security: SECURITY,
  request: {
    body: {
      content: {
        "application/json": { schema: CreateFeeStrategyRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: { description: "Fee strategy created" },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/fee-strategies/{id}",
  tags: ["Fee Strategies"],
  summary: "Get a fee strategy by ID (admin)",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Fee strategy details" },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/fee-strategies/{id}",
  tags: ["Fee Strategies"],
  summary: "Update a fee strategy (admin)",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: CreateFeeStrategyRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Fee strategy updated" },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/fee-strategies/{id}",
  tags: ["Fee Strategies"],
  summary: "Delete a fee strategy (admin)",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Fee strategy deleted" },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/fee-strategies/{id}/activate",
  tags: ["Fee Strategies"],
  summary: "Activate a fee strategy (admin)",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Strategy activated" },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/fee-strategies/{id}/deactivate",
  tags: ["Fee Strategies"],
  summary: "Deactivate a fee strategy (admin)",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Strategy deactivated" },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
