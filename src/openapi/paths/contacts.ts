/**
 * OpenAPI path registrations for /api/contacts/*
 */

import { z } from "zod";
import { registry } from "../registry";
import {
  CreateContactRequestSchema,
  UpdateContactRequestSchema,
  ContactSchema,
} from "../schemas/contacts";
import { ErrorResponseSchema } from "../schemas/common";

const TAG = "Contacts";
const SECURITY = [{ bearerAuth: [] }];

registry.registerPath({
  method: "post",
  path: "/api/contacts",
  tags: [TAG],
  summary: "Create a new contact",
  security: SECURITY,
  request: {
    body: {
      content: { "application/json": { schema: CreateContactRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Contact created",
      content: { "application/json": { schema: ContactSchema } },
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
  method: "get",
  path: "/api/contacts",
  tags: [TAG],
  summary: "List contacts for the authenticated user",
  security: SECURITY,
  responses: {
    200: {
      description: "List of contacts",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(ContactSchema),
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
  path: "/api/contacts/{id}",
  tags: [TAG],
  summary: "Get a contact by ID",
  security: SECURITY,
  request: {
    params: z.object({
      id: z
        .string()
        .uuid()
        .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    }),
  },
  responses: {
    200: {
      description: "Contact details",
      content: { "application/json": { schema: ContactSchema } },
    },
    404: {
      description: "Contact not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/contacts/{id}",
  tags: [TAG],
  summary: "Update a contact",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: UpdateContactRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Contact updated",
      content: { "application/json": { schema: ContactSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Contact not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/contacts/{id}",
  tags: [TAG],
  summary: "Delete a contact",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Contact deleted" },
    404: {
      description: "Contact not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
