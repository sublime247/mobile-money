/**
 * KYC domain schemas — derived from src/controllers/kycController.ts
 */

import { z } from "zod";
import { registry } from "../registry";

export const KYCAddressSchema = registry.register(
  "KYCAddress",
  z
    .object({
      street: z.string().min(1).openapi({ example: "123 Main St" }),
      town: z.string().min(1).openapi({ example: "Douala" }),
      postcode: z.string().min(1).openapi({ example: "00237" }),
      country: z
        .string()
        .length(3)
        .openapi({ example: "CMR", description: "ISO 3166-1 alpha-3" }),
      state: z.string().optional().openapi({ example: "Littoral" }),
      building_number: z.string().optional().openapi({ example: "12" }),
      flat_number: z.string().optional(),
    })
    .openapi("KYCAddress"),
);

export const CreateKYCApplicantRequestSchema = registry.register(
  "CreateKYCApplicantRequest",
  z
    .object({
      first_name: z.string().min(1).openapi({ example: "Jean" }),
      last_name: z.string().min(1).openapi({ example: "Dupont" }),
      email: z
        .string()
        .email()
        .optional()
        .openapi({ example: "jean.dupont@example.com" }),
      dob: z
        .string()
        .optional()
        .openapi({ example: "1990-01-15", description: "YYYY-MM-DD" }),
      phone_number: z.string().optional().openapi({ example: "+237670000000" }),
      address: KYCAddressSchema.optional(),
    })
    .openapi("CreateKYCApplicantRequest"),
);

export const KYCApplicantResponseSchema = registry.register(
  "KYCApplicantResponse",
  z
    .object({
      success: z.boolean().openapi({ example: true }),
      data: z.object({
        applicantId: z.string().openapi({ example: "applicant_abc123" }),
        status: z
          .enum(["pending", "approved", "rejected", "review"])
          .openapi({ example: "pending" }),
      }),
    })
    .openapi("KYCApplicantResponse"),
);

export const UploadKYCDocumentRequestSchema = registry.register(
  "UploadKYCDocumentRequest",
  z
    .object({
      applicant_id: z.string().openapi({ example: "applicant_abc123" }),
      type: z
        .enum([
          "passport",
          "driving_license",
          "national_identity_card",
          "residence_permit",
        ])
        .openapi({ example: "passport" }),
      side: z.enum(["front", "back"]).optional().openapi({ example: "front" }),
      filename: z.string().min(1).openapi({ example: "passport_front.jpg" }),
      data: z
        .string()
        .min(1)
        .openapi({ description: "Base64-encoded document image" }),
    })
    .openapi("UploadKYCDocumentRequest"),
);
export const KYCRejectionReasonSchema = registry.register(
  "KYCRejectionReason",
  z
    .enum([
      "Blurry ID",
      "Expired ID",
      "Name Mismatch",
      "Address Mismatch",
      "Selfie Mismatch",
      "Unsupported Document Type",
      "Fraudulent Document",
      "Incomplete Information",
      "Other",
    ])
    .openapi("KYCRejectionReason"),
);

export const RejectKYCRequestSchema = registry.register(
  "RejectKYCRequest",
  z
    .object({
      rejection_reason: KYCRejectionReasonSchema.openapi({
        example: "Blurry ID",
      }),
      notes: z
        .string()
        .optional()
        .openapi({
          example: "The ID is too blurry to read the expiration date.",
        }),
    })
    .required({ rejection_reason: true })
    .openapi("RejectKYCRequest"),
);
