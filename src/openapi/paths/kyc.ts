/**
 * OpenAPI path registrations for /api/kyc/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  CreateKYCApplicantRequestSchema,
  KYCApplicantResponseSchema,
  UploadKYCDocumentRequestSchema,
} from "../schemas/kyc";
import { ErrorResponseSchema } from "../schemas/common";

const TAG = "KYC";
const SECURITY = [{ bearerAuth: [] }];

registry.registerPath({
  method: "post",
  path: "/api/kyc/applicants",
  tags: [TAG],
  summary: "Create a KYC applicant",
  security: SECURITY,
  request: {
    body: {
      content: {
        "application/json": { schema: CreateKYCApplicantRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Applicant created",
      content: { "application/json": { schema: KYCApplicantResponseSchema } },
    },
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
  method: "post",
  path: "/api/kyc/documents",
  tags: [TAG],
  summary: "Upload a KYC identity document",
  security: SECURITY,
  request: {
    body: {
      content: {
        "application/json": { schema: UploadKYCDocumentRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: { description: "Document uploaded" },
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
  path: "/api/kyc/status",
  tags: [TAG],
  summary: "Get KYC status for the authenticated user",
  security: SECURITY,
  responses: {
    200: {
      description: "KYC status",
      content: {
        "application/json": {
          schema: z.object({
            level: z
              .enum(["none", "basic", "full"])
              .openapi({ example: "basic" }),
            status: z
              .enum(["pending", "approved", "rejected", "review"])
              .openapi({ example: "approved" }),
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
