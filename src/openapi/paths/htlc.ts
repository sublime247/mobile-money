/**
 * OpenAPI path registrations for /api/htlc/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  HtlcLockRequestSchema,
  HtlcClaimRequestSchema,
  HtlcRefundRequestSchema,
  HtlcTransactionResponseSchema,
} from "../schemas/htlc";
import { ErrorResponseSchema } from "../schemas/common";

const TAG = "HTLC";

registry.registerPath({
  method: "post",
  path: "/api/htlc/lock",
  tags: [TAG],
  summary: "Build a Stellar HTLC lock transaction",
  request: {
    body: {
      content: { "application/json": { schema: HtlcLockRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Lock transaction XDR",
      content: {
        "application/json": { schema: HtlcTransactionResponseSchema },
      },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/htlc/claim",
  tags: [TAG],
  summary: "Build a Stellar HTLC claim transaction",
  request: {
    body: {
      content: { "application/json": { schema: HtlcClaimRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Claim transaction XDR",
      content: {
        "application/json": { schema: HtlcTransactionResponseSchema },
      },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/htlc/refund",
  tags: [TAG],
  summary: "Build a Stellar HTLC refund transaction",
  request: {
    body: {
      content: { "application/json": { schema: HtlcRefundRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Refund transaction XDR",
      content: {
        "application/json": { schema: HtlcTransactionResponseSchema },
      },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/htlc/{contractId}",
  tags: [TAG],
  summary: "Get HTLC contract state",
  request: {
    params: z.object({
      contractId: z.string().openapi({ example: "contract_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "HTLC contract state",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
    400: {
      description: "Error fetching state",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
