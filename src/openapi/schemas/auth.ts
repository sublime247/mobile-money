/**
 * Auth domain schemas — derived from src/routes/auth.ts
 */

import { z } from "zod";
import { registry } from "../registry";

export const RegisterRequestSchema = registry.register(
  "RegisterRequest",
  z
    .object({
      phone_number: z.string().min(1).openapi({ example: "+237670000000" }),
      password: z.string().min(12).openapi({
        example: "Str0ng!Pass#2024",
        description:
          "Minimum 12 characters, must include uppercase, lowercase, and a special character.",
      }),
    })
    .openapi("RegisterRequest"),
);

export const LoginRequestSchema = registry.register(
  "LoginRequest",
  z
    .object({
      phone_number: z.string().openapi({ example: "+237670000000" }),
      password: z.string().openapi({ example: "Str0ng!Pass#2024" }),
    })
    .openapi("LoginRequest"),
);

export const LoginResponseSchema = registry.register(
  "LoginResponse",
  z
    .object({
      message: z.string().openapi({ example: "Login successful" }),
      token: z
        .string()
        .openapi({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }),
      refreshToken: z
        .string()
        .openapi({ example: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..." }),
      user: z.object({
        userId: z
          .string()
          .uuid()
          .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
        email: z.string().openapi({ example: "+237670000000" }),
        role: z.string().openapi({ example: "user" }),
        permissions: z
          .array(z.string())
          .openapi({ example: ["read:transactions"] }),
      }),
    })
    .openapi("LoginResponse"),
);

export const RefreshTokenRequestSchema = registry.register(
  "RefreshTokenRequest",
  z
    .object({
      refreshToken: z
        .string()
        .openapi({ example: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..." }),
    })
    .openapi("RefreshTokenRequest"),
);

export const TokenVerifyRequestSchema = registry.register(
  "TokenVerifyRequest",
  z
    .object({
      token: z
        .string()
        .openapi({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }),
    })
    .openapi("TokenVerifyRequest"),
);
