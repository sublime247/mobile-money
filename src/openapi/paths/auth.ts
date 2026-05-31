/**
 * OpenAPI path registrations for /api/auth/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshTokenRequestSchema,
  TokenVerifyRequestSchema,
} from "../schemas/auth";
import { ErrorResponseSchema } from "../schemas/common";

const TAG = "Auth";

registry.registerPath({
  method: "post",
  path: "/api/auth/register",
  tags: [TAG],
  summary: "Register a new user",
  request: {
    body: {
      content: { "application/json": { schema: RegisterRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "User registered successfully",
      content: {
        "application/json": {
          schema: z.object({
            message: z
              .string()
              .openapi({ example: "User registered successfully" }),
            userId: z
              .string()
              .uuid()
              .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
          }),
        },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  tags: [TAG],
  summary: "Authenticate and receive JWT tokens",
  request: {
    body: {
      content: { "application/json": { schema: LoginRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Login successful",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    401: {
      description: "Invalid credentials",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Account locked due to too many failed attempts",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/refresh",
  tags: [TAG],
  summary: "Rotate refresh token and issue new access token",
  request: {
    body: {
      content: { "application/json": { schema: RefreshTokenRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Token rotation successful",
      content: {
        "application/json": {
          schema: z.object({
            message: z
              .string()
              .openapi({ example: "Token rotation successful" }),
            token: z.string(),
            refreshToken: z.string(),
          }),
        },
      },
    },
    401: {
      description: "Invalid or expired refresh token",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/verify",
  tags: [TAG],
  summary: "Verify a JWT token",
  request: {
    body: {
      content: { "application/json": { schema: TokenVerifyRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Token is valid",
      content: {
        "application/json": {
          schema: z.object({
            valid: z.boolean().openapi({ example: true }),
            payload: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    401: {
      description: "Token invalid or expired",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/me",
  tags: [TAG],
  summary: "Get current authenticated user",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Current user info",
      content: {
        "application/json": {
          schema: z.object({
            user: z.object({
              userId: z.string().uuid(),
              email: z.string(),
              role: z.string(),
              permissions: z.array(z.string()),
              total_deposited: z.string(),
              total_withdrawn: z.string(),
              current_balance: z.string(),
            }),
            tokenInfo: z.object({
              issuedAt: z.number().optional(),
              expiresAt: z.number().optional(),
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
