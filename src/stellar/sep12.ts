import logger from "../utils/logger";
import { Router, Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { sep12RateLimiter } from "../middleware/rateLimit";
import { upload } from "../middleware/upload";
import { z } from "zod";
import KYCService, { KYCLevel, KYCStatus, DocumentType } from "../services/kyc";
import { validateCountryCode } from "../utils/validators";

// Zod refinement: accepts ISO 3166-1 alpha-2 OR alpha-3, validated against
// the expanded country map from validators.ts (issue #1579)
const isoCountryCode = z
  .string()
  .refine(
    (val) => validateCountryCode(val).valid,
    { message: "Invalid ISO 3166-1 country code" },
  );
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { UserModel } from "../models/users";
import { CustomerDataMaskingService } from "../services/customerDataMaskingService";
import {
  createDeleteCustomerHandler,
  sep12DocumentUploadMiddleware,
} from "../routes/sep12";
import {
  kycSanitizeBody,
  sanitizeKycPayload,
  sanitizeKycString,
} from "../validators/kycSanitizer";
import {
  CustomerService,
  defaultCustomerService,
  customerEvents,
  CustomerTransitionResult,
} from "../services/customerService";
import {
  KYC_STATUS_UPDATED,
  KycStatusUpdatedEvent,
  kycStatusEvents,
} from "../services/kycStatusEvents";

/**
 * SEP-12: KYC API
 * * This implements the Stellar Ecosystem Proposal 12 (SEP-12) standard for
 * customer information collection and KYC verification.
 * * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum Sep12CustomerStatus {
  ACCEPTED = "ACCEPTED",
  PROCESSING = "PROCESSING",
  NEEDS_INFO = "NEEDS_INFO",
  REJECTED = "REJECTED",
}

export interface Sep12CustomerFields {
  // Natural person fields
  first_name?: string;
  last_name?: string;
  email_address?: string;
  mobile_number?: string;
  birth_date?: string;
  birth_place?: string;
  birth_country?: string;

  // Address fields
  address?: string;
  address_country_code?: string;
  state_or_province?: string;
  city?: string;
  postal_code?: string;

  // ID document fields
  id_type?: string;
  id_country_code?: string;
  id_issue_date?: string;
  id_expiration_date?: string;
  id_number?: string;

  // Photo ID
  photo_id_front?: string; // Base64 or URL
  photo_id_back?: string;
  photo_proof_residence?: string;
  biometric_photo?: string; // Live photo used for face-match verification

  // Organization fields (for businesses)
  organization_name?: string;
  organization_registration_number?: string;
  organization_registration_date?: string;
  organization_registered_address?: string;

  // Additional fields
  tax_id?: string;
  tax_id_name?: string;
  occupation?: string;
  employer_name?: string;
  employer_address?: string;
}

export interface Sep12ProvidedField {
  type: string;
  description: string;
  choices?: string[];
  optional?: boolean;
}

export interface Sep12CustomerResponse {
  id: string;
  status: Sep12CustomerStatus;
  fields?: Record<string, Sep12ProvidedField>;
  provided_fields?: Record<string, Sep12ProvidedField>;
  message?: string;
}

// ============================================================================
// Validation Schemas
// ============================================================================

const PutCustomerSchema = z.object({
  account: z.string().optional(),
  memo: z.string().optional(),
  memo_type: z.enum(["id", "hash", "text"]).optional(),
  type: z.string().optional(),
  
  // Natural person fields
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email_address: z.string().email().optional(),
  mobile_number: z.string().optional(),
  birth_date: z.string().optional(),
  birth_place: z.string().optional(),
  birth_country: z.string().optional(),
  
  // Address
  address: z.string().optional(),
  address_country_code: isoCountryCode.optional(),
  state_or_province: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  
  // ID document
  id_type: z.string().optional(),
  id_country_code: isoCountryCode.optional(),
  id_issue_date: z.string().optional(),
  id_expiration_date: z.string().optional(),
  id_number: z.string().optional(),
  
  // Photos (base64 or URLs)
  photo_id_front: z.string().optional(),
  photo_id_back: z.string().optional(),
  photo_proof_residence: z.string().optional(),
  biometric_photo: z.string().optional(),
  
  // Organization
  organization_name: z.string().optional(),
  organization_registration_number: z.string().optional(),
  organization_registration_date: z.string().optional(),
  organization_registered_address: z.string().optional(),
  
  // Additional
  tax_id: z.string().optional(),
  tax_id_name: z.string().optional(),
  occupation: z.string().optional(),
  employer_name: z.string().optional(),
  employer_address: z.string().optional(),
}).catchall(z.any()); // Catch all unmapped dynamic fields

// ============================================================================
// Customer status webhook payload (#2427)
// ============================================================================

/**
 * Body POSTed to registered partner anchors when a customer's KYC review
 * completes. Deliveries are signed with HMAC-SHA256 over
 * `<timestamp>.<body>` using the partner's shared secret (headers
 * `X-Momo-Signature`, `X-Momo-Timestamp`, `X-Webhook-Signature`) and queued
 * in BullMQ with retries — see `queue/customerCallbackQueue.ts`.
 */
export const Sep12StatusWebhookPayloadSchema = z
  .object({
    event: z.enum(["customer.kyc.accepted", "customer.kyc.rejected"]),
    event_id: z.string().min(1),
    customer_id: z.string().min(1),
    account: z.string().nullable(),
    previous_status: z.nativeEnum(Sep12CustomerStatus),
    current_status: z.enum([
      Sep12CustomerStatus.ACCEPTED,
      Sep12CustomerStatus.REJECTED,
    ]),
    status: z.enum([Sep12CustomerStatus.ACCEPTED, Sep12CustomerStatus.REJECTED]),
    reason: z.string().nullable(),
    timestamp: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.status === Sep12CustomerStatus.ACCEPTED && payload.reason) {
      ctx.addIssue({
        code: "custom",
        message: "reason is only sent for REJECTED customers",
        path: ["reason"],
      });
    }
  });

export type Sep12StatusWebhookPayload = z.infer<
  typeof Sep12StatusWebhookPayloadSchema
>;

/** Statuses that trigger a partner webhook. */
const NOTIFIABLE_STATUSES = new Set<Sep12CustomerStatus>([
  Sep12CustomerStatus.ACCEPTED,
  Sep12CustomerStatus.REJECTED,
]);

// ============================================================================
// SEP-12 Service
// ============================================================================

export class Sep12Service {
  private kycService: KYCService;
  private db: Pool;
  private userModel: UserModel;
  public customerService: CustomerService;

  constructor(db: Pool, customerService?: CustomerService) {
    this.db = db;
    this.kycService = new KYCService(db);
    this.userModel = new UserModel();
    this.customerService = customerService || defaultCustomerService;
  }

  /**
   * Notify registered partner anchors that a customer's KYC review finished.
   *
   * Dispatches only when the customer moves into ACCEPTED or REJECTED from a
   * different status; repeated provider events for an unchanged status are
   * ignored. The failure reason is included only for REJECTED customers.
   *
   * @returns the transition result, or `null` when no webhook is due.
   */
  async notifyCustomerStatusChange(
    event: KycStatusUpdatedEvent,
  ): Promise<CustomerTransitionResult | null> {
    if (!event.userId) {
      return null;
    }

    const level = (event.kycLevel as KYCLevel) || KYCLevel.NONE;
    const currentStatus = this.mapKYCStatusToSep12(
      event.status as KYCStatus,
      level,
    );
    if (!NOTIFIABLE_STATUSES.has(currentStatus)) {
      return null;
    }

    const previousStatus = event.previousStatus
      ? this.mapKYCStatusToSep12(event.previousStatus as KYCStatus, level)
      : Sep12CustomerStatus.PROCESSING;
    if (
      event.previousStatus &&
      (event.previousStatus === event.status ||
        previousStatus === currentStatus)
    ) {
      return null;
    }

    let account: string | undefined;
    try {
      const result = await this.db.query<{ stellar_address: string | null }>(
        "SELECT stellar_address FROM users WHERE id = $1",
        [event.userId],
      );
      account = result.rows[0]?.stellar_address ?? undefined;
    } catch (error) {
      logger.warn(
        {
          customerId: event.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[SEP-12] Could not resolve Stellar account for status webhook",
      );
    }

    const isRejected = currentStatus === Sep12CustomerStatus.REJECTED;
    return this.customerService.transitionCustomerStatus({
      customerId: event.userId,
      account,
      previousStatus,
      currentStatus,
      reason: isRejected
        ? event.rejectionReason || "Customer verification was rejected"
        : undefined,
    });
  }

  /**
   * Map internal KYC status to SEP-12 status
   */
  private mapKYCStatusToSep12(
    kycStatus: KYCStatus,
    kycLevel: KYCLevel,
  ): Sep12CustomerStatus {
    if (kycStatus === KYCStatus.REJECTED) {
      return Sep12CustomerStatus.REJECTED;
    }

    if (kycStatus === KYCStatus.PENDING || kycStatus === KYCStatus.REVIEW) {
      return Sep12CustomerStatus.PROCESSING;
    }

    if (kycStatus === KYCStatus.APPROVED) {
      // Check if we need more info based on KYC level
      if (kycLevel === KYCLevel.NONE || kycLevel === KYCLevel.BASIC) {
        return Sep12CustomerStatus.NEEDS_INFO;
      }
      return Sep12CustomerStatus.ACCEPTED;
    }

    return Sep12CustomerStatus.NEEDS_INFO;
  }

  /**
   * Get required fields based on customer type and current status
   */
  private getRequiredFields(
    type?: string,
    kycLevel?: KYCLevel,
  ): Record<string, Sep12ProvidedField> {
    const naturalPersonFields: Record<string, Sep12ProvidedField> = {
      first_name: {
        type: "string",
        description: "First or given name",
        optional: false,
      },
      last_name: {
        type: "string",
        description: "Last or family name",
        optional: false,
      },
      email_address: {
        type: "string",
        description: "Email address",
        optional: false,
      },
      mobile_number: {
        type: "string",
        description: "Mobile phone number with country code",
        optional: true,
      },
      birth_date: {
        type: "date",
        description: "Date of birth (YYYY-MM-DD)",
        optional: false,
      },
      address: {
        type: "string",
        description: "Full street address",
        optional: false,
      },
      city: {
        type: "string",
        description: "City of residence",
        optional: false,
      },
      postal_code: {
        type: "string",
        description: "Postal or ZIP code",
        optional: false,
      },
      address_country_code: {
        type: "string",
        description: "ISO 3166-1 alpha-3 country code",
        optional: false,
      },
    };

    // Add document fields for higher KYC levels
    if (
      !kycLevel ||
      kycLevel === KYCLevel.NONE ||
      kycLevel === KYCLevel.BASIC
    ) {
      naturalPersonFields.id_type = {
        type: "string",
        description: "Type of ID document",
        choices: [
          "passport",
          "drivers_license",
          "national_id",
          "residence_permit",
        ],
        optional: false,
      };
      naturalPersonFields.id_number = {
        type: "string",
        description: "ID document number",
        optional: false,
      };
      naturalPersonFields.id_country_code = {
        type: "string",
        description: "Country that issued the ID",
        optional: false,
      };
      naturalPersonFields.photo_id_front = {
        type: "binary",
        description: "Image of front of ID document",
        optional: false,
      };
      naturalPersonFields.photo_id_back = {
        type: "binary",
        description: "Image of back of ID document",
        optional: true,
      };
    }

    // Organization fields
    if (type === "organization") {
      return {
        organization_name: {
          type: "string",
          description: "Legal name of organization",
          optional: false,
        },
        organization_registration_number: {
          type: "string",
          description: "Business registration number",
          optional: false,
        },
        organization_registered_address: {
          type: "string",
          description: "Registered business address",
          optional: false,
        },
        address_country_code: {
          type: "string",
          description: "ISO 3166-1 alpha-3 country code",
          optional: false,
        },
      };
    }

    return naturalPersonFields;
  }

  /**
   * Get customer information
   */
  async getCustomer(
    account?: string,
    memo?: string,
    memoType?: string,
    type?: string,
  ): Promise<Sep12CustomerResponse> {
    try {
      // Find customer by Stellar account and memo
      const customerQuery = `
        SELECT u.id, u.kyc_level, ka.applicant_id, ka.verification_status
        FROM users u
        LEFT JOIN kyc_applicants ka ON u.id = ka.user_id
        WHERE u.stellar_address = $1
          AND u.anonymized_at IS NULL
        ORDER BY ka.updated_at DESC
        LIMIT 1
      `;

      const result = await this.db.query(customerQuery, [account]);

      if (result.rows.length === 0) {
        // Customer not found - return required fields
        return {
          id: "",
          status: Sep12CustomerStatus.NEEDS_INFO,
          fields: this.getRequiredFields(type),
          message: "Customer information required",
        };
      }

      const customer = result.rows[0];
      const kycLevel = customer.kyc_level as KYCLevel;
      const kycStatus =
        (customer.verification_status as KYCStatus) || KYCStatus.PENDING;

      const sep12Status = this.mapKYCStatusToSep12(kycStatus, kycLevel);

      // Get provided fields from KYC applicant
      const providedFields: Record<string, Sep12ProvidedField> = {};

      if (customer.applicant_id) {
        try {
          const applicant = await this.kycService.getApplicant(
            customer.applicant_id,
          );

          if (applicant.first_name) {
            providedFields.first_name = {
              type: "string",
              description: "First name",
            };
          }
          if (applicant.last_name) {
            providedFields.last_name = {
              type: "string",
              description: "Last name",
            };
          }
          if (applicant.email) {
            providedFields.email_address = {
              type: "string",
              description: "Email address",
            };
          }
          if (applicant.address) {
            providedFields.address = {
              type: "string",
              description: "Street address",
            };
          }
        } catch (error) {
          logger.error("Error fetching applicant:", error);
        }
      }

      const response: Sep12CustomerResponse = {
        id: customer.id,
        status: sep12Status,
        provided_fields: providedFields,
      };

      // Add required fields if more info is needed
      if (sep12Status === Sep12CustomerStatus.NEEDS_INFO) {
        response.fields = this.getRequiredFields(type, kycLevel);
        response.message = "Additional information required for verification";
      }

      if (sep12Status === Sep12CustomerStatus.REJECTED) {
        response.message = "Customer verification was rejected";
      }

      if (sep12Status === Sep12CustomerStatus.PROCESSING) {
        response.message = "Customer information is being processed";
      }

      return response;
    } catch (error) {
      logger.error("Error getting customer:", error);
      throw new Error(
        `Failed to get customer: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Create or update customer information
   */
  async putCustomer(
    data: z.infer<typeof PutCustomerSchema>,
  ): Promise<Sep12CustomerResponse> {
    try {
      const validatedData = PutCustomerSchema.parse(data);
      // Sanitize all string fields (issue #1973): reject HTML/SQL/command
      // injection payloads and escape the surviving values before persistence.
      const {
        account,
        memo,
        memo_type,
        type,
        first_name: rawFirstName,
        last_name: rawLastName,
        email_address,
        mobile_number,
        birth_date,
        birth_place,
        birth_country,
        address: rawAddress,
        address_country_code,
        state_or_province,
        city: rawCity,
        postal_code,
        id_type,
        id_country_code,
        id_issue_date,
        id_expiration_date,
        id_number: rawIdNumber,
        photo_id_front,
        photo_id_back,
        photo_proof_residence,
        biometric_photo,
        organization_name: rawOrganizationName,
        organization_registration_number: rawOrganizationRegNumber,
        organization_registration_date,
        organization_registered_address: rawOrganizationAddress,
        tax_id: rawTaxId,
        tax_id_name,
        occupation: rawOccupation,
        employer_name: rawEmployerName,
        employer_address: rawEmployerAddress,
        ...customFields
      } = validatedData;

      const first_name = rawFirstName ? sanitizeKycString("first_name", rawFirstName) : rawFirstName;
      const last_name = rawLastName ? sanitizeKycString("last_name", rawLastName) : rawLastName;
      const address = rawAddress ? sanitizeKycString("address", rawAddress) : rawAddress;
      const city = rawCity ? sanitizeKycString("city", rawCity) : rawCity;
      const id_number = rawIdNumber ? sanitizeKycString("id_number", rawIdNumber) : rawIdNumber;
      const organization_name = rawOrganizationName
        ? sanitizeKycString("organization_name", rawOrganizationName)
        : rawOrganizationName;
      const organization_registration_number = rawOrganizationRegNumber
        ? sanitizeKycString("organization_registration_number", rawOrganizationRegNumber)
        : rawOrganizationRegNumber;
      const organization_registered_address = rawOrganizationAddress
        ? sanitizeKycString("organization_registered_address", rawOrganizationAddress)
        : rawOrganizationAddress;
      const tax_id = rawTaxId ? sanitizeKycString("tax_id", rawTaxId) : rawTaxId;
      const occupation = rawOccupation ? sanitizeKycString("occupation", rawOccupation) : rawOccupation;
      const employer_name = rawEmployerName
        ? sanitizeKycString("employer_name", rawEmployerName)
        : rawEmployerName;
      const employer_address = rawEmployerAddress
        ? sanitizeKycString("employer_address", rawEmployerAddress)
        : rawEmployerAddress;

      // Find or create user by Stellar account
      let userId: string;
      let applicantId: string | null = null;

      if (account) {
        const userQuery = `
          SELECT u.id, ka.applicant_id
          FROM users u
          LEFT JOIN kyc_applicants ka ON u.id = ka.user_id
          WHERE u.stellar_address = $1
          ORDER BY ka.updated_at DESC
          LIMIT 1
        `;

        const userResult = await this.db.query(userQuery, [account]);

        if (userResult.rows.length > 0) {
          userId = userResult.rows[0].id;
          applicantId = userResult.rows[0].applicant_id;
        } else {
          // Create new user
          const createUserQuery = `
            INSERT INTO users (stellar_address, kyc_level, phone_number)
            VALUES ($1, $2, $3)
            RETURNING id
          `;

          const newUserResult = await this.db.query(createUserQuery, [
            account,
            KYCLevel.NONE,
            mobile_number || "pending",
          ]);

          userId = newUserResult.rows[0].id;
        }
      } else {
        throw new Error("account parameter is required");
      }

      // Create or update KYC applicant
      const applicantData = {
        first_name: first_name || "",
        last_name: last_name || "",
        email: email_address,
        dob: birth_date,
        phone_number: mobile_number,
        address: address
          ? {
              street: address,
              town: city || "",
              postcode: postal_code || "",
              country: address_country_code || "USA",
              state: state_or_province,
            }
          : undefined,
        custom_fields:
          Object.keys(customFields).length > 0
            ? (sanitizeKycPayload(customFields) as typeof customFields)
            : undefined,
      };

      let applicant;

      if (applicantId) {
        // Update existing applicant
        applicant = await this.kycService.getApplicant(applicantId);
      } else {
        // Create new applicant
        applicant = await this.kycService.createApplicant(applicantData);
        applicantId = applicant.id;

        // Link applicant to user
        const linkQuery = `
          INSERT INTO kyc_applicants (user_id, applicant_id, provider, verification_status, kyc_level)
          VALUES ($1, $2, 'entrust', 'pending', 'none')
          ON CONFLICT (user_id, applicant_id) DO UPDATE
          SET updated_at = CURRENT_TIMESTAMP
        `;

        await this.db.query(linkQuery, [userId, applicantId]);
      }

      // Save sensitive fields in users table in encrypted form
      await this.userModel.updateSensitiveData(userId, {
        firstName: first_name,
        lastName: last_name,
        address: address,
        dateOfBirth: birth_date,
        idNumber: id_number,
      });

      // Handle document uploads if provided
      if (photo_id_front) {
        const docType = this.mapIdTypeToDocumentType(id_type);

        await this.kycService.uploadDocument({
          applicant_id: applicantId,
          type: docType,
          side: "front",
          filename: `id_front_${Date.now()}.jpg`,
          data: photo_id_front,
        });
      }

      if (photo_id_back) {
        const docType = this.mapIdTypeToDocumentType(id_type);

        await this.kycService.uploadDocument({
          applicant_id: applicantId,
          type: docType,
          side: "back",
          filename: `id_back_${Date.now()}.jpg`,
          data: photo_id_back,
        });
      }

      if (biometric_photo) {
        if (!applicantId) {
          throw new Error("applicantId is required for face-match verification");
        }
        await this.kycService.submitFaceMatch({
          applicantId,
          biometricPayload: biometric_photo,
          filename: `biometric_${Date.now()}.jpg`,
        });
      }

      // Process dynamic custom fields/documents attached
      for (const [key, value] of Object.entries(customFields)) {
        if (typeof value === "string" && value.length > 500) {
          const docType = this.mapIdTypeToDocumentType(id_type);
          await this.kycService.uploadDocument({
            applicant_id: applicantId,
            type: docType, // Or map to a generic "other" document type
            side: "front",
            filename: `${key}_${Date.now()}.png`,
            data: value,
          });
        }
      }

      // Return customer status
      return {
        id: userId,
        status: Sep12CustomerStatus.PROCESSING,
        message: "Customer information received and is being processed",
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Validation error: ${error.message}`);
      }
      logger.error("Error putting customer:", error);
      throw new Error(
        `Failed to update customer: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Delete customer information (GDPR / NDPR erasure).
   *
   * Personal data is anonymized rather than hard-deleted so the financial
   * audit trail survives — see {@link CustomerDataMaskingService}.
   *
   * @returns `false` when no customer exists for the account.
   */
  async deleteCustomer(account: string): Promise<boolean> {
    const result = await new CustomerDataMaskingService(
      this.db,
    ).anonymizeByStellarAccount(account);
    return result !== null;
  }

  /**
   * Map SEP-12 ID type to internal document type
   */
  private mapIdTypeToDocumentType(idType?: string): DocumentType {
    switch (idType?.toLowerCase()) {
      case "passport":
        return DocumentType.PASSPORT;
      case "drivers_license":
      case "driving_license":
        return DocumentType.DRIVING_LICENSE;
      case "national_id":
      case "national_identity_card":
        return DocumentType.NATIONAL_IDENTITY_CARD;
      case "residence_permit":
        return DocumentType.RESIDENCE_PERMIT;
      default:
        return DocumentType.NATIONAL_IDENTITY_CARD;
    }
  }
}

// ============================================================================
// KYC status → partner webhook trigger
// ============================================================================

let activeKycStatusListener:
  | ((event: KycStatusUpdatedEvent) => void)
  | null = null;

/**
 * Subscribe `service` to KYC status updates so partner anchors are notified
 * when a customer is accepted or rejected. Only one trigger is active at a
 * time; attaching again replaces the previous one so repeated router
 * construction never sends duplicate webhooks.
 *
 * @returns a function that detaches the trigger.
 */
export function attachKycStatusWebhookTrigger(
  service: Sep12Service,
): () => void {
  detachKycStatusWebhookTrigger();

  const listener = (event: KycStatusUpdatedEvent) => {
    service.notifyCustomerStatusChange(event).catch((error) => {
      logger.error(
        {
          applicantId: event.applicantId,
          customerId: event.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[SEP-12] Failed to dispatch customer status webhook",
      );
    });
  };

  kycStatusEvents.on(KYC_STATUS_UPDATED, listener);
  activeKycStatusListener = listener;

  return () => {
    if (activeKycStatusListener === listener) {
      detachKycStatusWebhookTrigger();
    }
  };
}

export function detachKycStatusWebhookTrigger(): void {
  if (activeKycStatusListener) {
    kycStatusEvents.off(KYC_STATUS_UPDATED, activeKycStatusListener);
    activeKycStatusListener = null;
  }
}

// ============================================================================
// Express Router
// ============================================================================

export const createSep12Router = (db: Pool): Router => {
  const router = Router();
  const sep12Service = new Sep12Service(db);

  // Notify partner anchors when KYC review completes (#2427).
  attachKycStatusWebhookTrigger(sep12Service);

  // Rate limiter for SEP-12 endpoints
  const sep12Limiter = sep12RateLimiter;

  /**
   * GET /customer
   * * Retrieve customer information and KYC status
   */
  router.get("/customer", sep12Limiter, async (req: Request, res: Response) => {
    try {
      const { account, memo, memo_type, type } = req.query;

      if (!account) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "account parameter is required",
          {
            error: "account parameter is required",
          },
        );
      }

      const customer = await sep12Service.getCustomer(
        account as string,
        memo as string,
        memo_type as string,
        type as string,
      );

      res.json(customer);
    } catch (error: any) {
      if (error.statusCode) throw error;
      logger.error("[SEP-12] Error getting customer:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        error.message || "Failed to get customer information",
        {
          error: error.message || "Failed to get customer information",
        },
      );
    }
  });

  /**
   * PUT /customer
   * * Create or update customer information
   */
  router.put(
    "/customer",
    sep12Limiter,
    sep12DocumentUploadMiddleware,
    kycSanitizeBody,
    async (req: Request, res: Response) => {
      try {
        const customerData = { ...req.body };
        const customer = await sep12Service.putCustomer(customerData);
        res.json(customer);
      } catch (error: any) {
        logger.error("[SEP-12] Error putting customer:", error);
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          error.message || "Failed to update customer information",
          {
            error: error.message || "Failed to update customer information",
          },
        );
      }
    },
  );

  /**
   * DELETE /customer/:account
   * * Anonymize customer PII (GDPR / NDPR) while keeping the AML audit trail.
   */
  router.delete(
    "/customer/:account",
    sep12Limiter,
    createDeleteCustomerHandler(new CustomerDataMaskingService(db)),
  );

  return router;
};

export { CustomerService, defaultCustomerService, customerEvents };
export default createSep12Router;
