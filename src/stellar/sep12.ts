import { Router, Request, Response } from "express";
import { Pool } from "pg";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import KYCService, { KYCLevel, KYCStatus, DocumentType } from "../services/kyc";

/**
 * SEP-12: KYC API
 * 
 * This implements the Stellar Ecosystem Proposal 12 (SEP-12) standard for
 * customer information collection and KYC verification.
 * 
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
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
  address_country_code: z.string().length(3).optional(),
  state_or_province: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  
  // ID document
  id_type: z.string().optional(),
  id_country_code: z.string().length(3).optional(),
  id_issue_date: z.string().optional(),
  id_expiration_date: z.string().optional(),
  id_number: z.string().optional(),
  
  // Photos (base64 or URLs)
  photo_id_front: z.string().optional(),
  photo_id_back: z.string().optional(),
  photo_proof_residence: z.string().optional(),
  
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
});

// ============================================================================
// SEP-12 Service
// ============================================================================

export class Sep12Service {
  private kycService: KYCService;
  private db: Pool;

  constructor(db: Pool) {
    this.db = db;
    this.kycService = new KYCService(db);
  }

  /**
   * Map internal KYC status to SEP-12 status
   */
  private mapKYCStatusToSep12(kycStatus: KYCStatus, kycLevel: KYCLevel): Sep12CustomerStatus {
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
  private getRequiredFields(type?: string, kycLevel?: KYCLevel): Record<string, Sep12ProvidedField> {
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
    if (!kycLevel || kycLevel === KYCLevel.NONE || kycLevel === KYCLevel.BASIC) {
      naturalPersonFields.id_type = {
        type: "string",
        description: "Type of ID document",
        choices: ["passport", "drivers_license", "national_id", "residence_permit"],
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
    type?: string
  ): Promise<Sep12CustomerResponse> {
    try {
      // Find customer by Stellar account and memo
      const customerQuery = `
        SELECT u.id, u.kyc_level, ka.applicant_id, ka.verification_status
        FROM users u
        LEFT JOIN kyc_applicants ka ON u.id = ka.user_id
        WHERE u.stellar_address = $1
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
      const kycStatus = customer.verification_status as KYCStatus || KYCStatus.PENDING;
      
      const sep12Status = this.mapKYCStatusToSep12(kycStatus, kycLevel);
      
      // Get provided fields from KYC applicant
      const providedFields: Record<string, Sep12ProvidedField> = {};
      
      if (customer.applicant_id) {
        try {
          const applicant = await this.kycService.getApplicant(customer.applicant_id);
          
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
          console.error("Error fetching applicant:", error);
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
      console.error("Error getting customer:", error);
      throw new Error(`Failed to get customer: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Create or update customer information
   */
  async putCustomer(
    data: z.infer<typeof PutCustomerSchema>
  ): Promise<Sep12CustomerResponse> {
    try {
      const validatedData = PutCustomerSchema.parse(data);
      
      // Find or create user by Stellar account
      let userId: string;
      let applicantId: string | null = null;
      
      if (validatedData.account) {
        const userQuery = `
          SELECT u.id, ka.applicant_id
          FROM users u
          LEFT JOIN kyc_applicants ka ON u.id = ka.user_id
          WHERE u.stellar_address = $1
          ORDER BY ka.updated_at DESC
          LIMIT 1
        `;
        
        const userResult = await this.db.query(userQuery, [validatedData.account]);
        
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
            validatedData.account,
            KYCLevel.NONE,
            validatedData.mobile_number || "pending",
          ]);
          
          userId = newUserResult.rows[0].id;
        }
      } else {
        throw new Error("account parameter is required");
      }

      // Create or update KYC applicant
      const applicantData = {
        first_name: validatedData.first_name || "",
        last_name: validatedData.last_name || "",
        email: validatedData.email_address,
        dob: validatedData.birth_date,
        phone_number: validatedData.mobile_number,
        address: validatedData.address ? {
          street: validatedData.address,
          town: validatedData.city || "",
          postcode: validatedData.postal_code || "",
          country: validatedData.address_country_code || "USA",
          state: validatedData.state_or_province,
        } : undefined,
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

      // Handle document uploads if provided
      if (validatedData.photo_id_front) {
        const docType = this.mapIdTypeToDocumentType(validatedData.id_type);
        
        await this.kycService.uploadDocument({
          applicant_id: applicantId,
          type: docType,
          side: "front",
          filename: `id_front_${Date.now()}.jpg`,
          data: validatedData.photo_id_front,
        });
      }

      if (validatedData.photo_id_back) {
        const docType = this.mapIdTypeToDocumentType(validatedData.id_type);
        
        await this.kycService.uploadDocument({
          applicant_id: applicantId,
          type: docType,
          side: "back",
          filename: `id_back_${Date.now()}.jpg`,
          data: validatedData.photo_id_back,
        });
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
      console.error("Error putting customer:", error);
      throw new Error(`Failed to update customer: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Delete customer information
   */
  async deleteCustomer(account: string): Promise<void> {
    try {
      const deleteQuery = `
        DELETE FROM kyc_applicants
        WHERE user_id IN (
          SELECT id FROM users WHERE stellar_address = $1
        )
      `;
      
      await this.db.query(deleteQuery, [account]);
    } catch (error) {
      console.error("Error deleting customer:", error);
      throw new Error(`Failed to delete customer: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
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
// Express Router
// ============================================================================

export const createSep12Router = (db: Pool): Router => {
  const router = Router();
  const sep12Service = new Sep12Service(db);

  // Rate limiter for SEP-12 endpoints
  const sep12Limiter = process.env.NODE_ENV === "test"
    ? (req: any, res: any, next: any) => next()
    : rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: "Too many requests, please try again later",
        },
      });

  /**
   * GET /customer
   * 
   * Retrieve customer information and KYC status
   */
  router.get("/customer", sep12Limiter, async (req: Request, res: Response) => {
    try {
      const { account, memo, memo_type, type } = req.query;

      if (!account) {
        return res.status(400).json({
          error: "account parameter is required",
        });
      }

      const customer = await sep12Service.getCustomer(
        account as string,
        memo as string,
        memo_type as string,
        type as string
      );

      res.json(customer);
    } catch (error: any) {
      console.error("[SEP-12] Error getting customer:", error);
      res.status(500).json({
        error: error.message || "Failed to get customer information",
      });
    }
  });

  /**
   * PUT /customer
   * 
   * Create or update customer information
   */
  router.put("/customer", sep12Limiter, async (req: Request, res: Response) => {
    try {
      const customer = await sep12Service.putCustomer(req.body);
      res.json(customer);
    } catch (error: any) {
      console.error("[SEP-12] Error putting customer:", error);
      res.status(400).json({
        error: error.message || "Failed to update customer information",
      });
    }
  });

  /**
   * DELETE /customer/:account
   * 
   * Delete customer information (GDPR compliance)
   */
  router.delete("/customer/:account", sep12Limiter, async (req: Request, res: Response) => {
    try {
      const { account } = req.params;

      if (!account) {
        return res.status(400).json({
          error: "account parameter is required",
        });
      }

      await sep12Service.deleteCustomer(account);
      
      res.status(204).send();
    } catch (error: any) {
      console.error("[SEP-12] Error deleting customer:", error);
      res.status(500).json({
        error: error.message || "Failed to delete customer information",
      });
    }
  });

  return router;
};

export default createSep12Router;
