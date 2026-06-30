/**
 * Contacts domain schemas — derived from src/routes/contacts.ts
 */

import { z } from "zod";
import { registry } from "../registry";

export const CreateContactRequestSchema = registry.register(
  "CreateContactRequest",
  z
    .object({
      destinationType: z
        .enum(["phone", "stellar"])
        .openapi({ example: "phone" }),
      destinationValue: z.string().min(1).openapi({
        example: "+237670000000",
        description:
          "E.164 phone number or Stellar public key depending on destinationType",
      }),
      nickname: z.string().min(1).max(100).openapi({ example: "Mom" }),
    })
    .openapi("CreateContactRequest"),
);

export const UpdateContactRequestSchema = registry.register(
  "UpdateContactRequest",
  z
    .object({
      destinationType: z
        .enum(["phone", "stellar"])
        .optional()
        .openapi({ example: "stellar" }),
      destinationValue: z.string().min(1).optional().openapi({
        example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      }),
      nickname: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .openapi({ example: "Dad" }),
    })
    .openapi("UpdateContactRequest"),
);

export const ContactSchema = registry.register(
  "Contact",
  z
    .object({
      id: z
        .string()
        .uuid()
        .openapi({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
      userId: z
        .string()
        .uuid()
        .openapi({ example: "b2c3d4e5-f6a7-8901-bcde-f12345678901" }),
      destinationType: z
        .enum(["phone", "stellar"])
        .openapi({ example: "phone" }),
      destinationValue: z.string().openapi({ example: "+237670000000" }),
      nickname: z.string().openapi({ example: "Mom" }),
      createdAt: z
        .string()
        .datetime()
        .openapi({ example: "2024-04-25T10:00:00.000Z" }),
    })
    .openapi("Contact"),
);
