import { Request, Response } from 'express';
import crypto from 'crypto';
import { Pool } from 'pg';
import KYCService, { KYCLevel, DocumentType } from '../services/kyc';
import { z } from 'zod';
import { UserModel } from '../models/users';
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import logger from "../utils/logger";

// Validation schemas
const CreateApplicantSchema = z.object({
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email format").optional(),
  dob: z.string().optional(),
  phone_number: z.string().optional(),
  address: z
    .object({
      flat_number: z.string().optional(),
      building_number: z.string().optional(),
      building_name: z.string().optional(),
      street: z.string().min(1, "Street is required"),
      sub_street: z.string().optional(),
      town: z.string().min(1, "Town is required"),
      state: z.string().optional(),
      postcode: z.string().min(1, "Postcode is required"),
      country: z.string().length(3, "Country must be 3 characters"),
      line1: z.string().optional(),
      line2: z.string().optional(),
      line3: z.string().optional(),
    })
    .optional(),
  custom_fields: z.record(z.string(), z.any()).optional(), // Added custom fields support
});

const UploadDocumentSchema = z.object({
  applicant_id: z.string(),
  type: z.nativeEnum(DocumentType),
  side: z.enum(["front", "back"]).optional(),
  filename: z.string().min(1, "Filename is required"),
  data: z.string().min(1, "Document data is required"),
});

const CreateWorkflowRunSchema = z.object({
  applicant_id: z.string(),
  workflow_id: z.string().optional(),
});

const GenerateSDKTokenSchema = z.object({
  applicant_id: z.string(),
  application_id: z.string(),
});

export class KYCController {
  private kycService: KYCService;
  private db: Pool;
  private userModel: UserModel;

  constructor(db: Pool) {
    this.db = db;
    this.kycService = new KYCService(db);
    this.userModel = new UserModel();
  }

  /**
   * Create a new KYC applicant
   * POST /api/kyc/applicants
   */
  createApplicant = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const validatedData = CreateApplicantSchema.parse(req.body);

      // Create applicant with KYC provider
      const applicant = await this.kycService.createApplicant(validatedData);

      // Store applicant reference with user
      await this.storeApplicantReference(userId, applicant.id);

      // Save sensitive fields in users table in encrypted form
      await this.userModel.updateSensitiveData(userId, {
        firstName: validatedData.first_name,
        lastName: validatedData.last_name,
        address: validatedData.address ? `${validatedData.address.building_number || ''} ${validatedData.address.street}, ${validatedData.address.town}, ${validatedData.address.postcode}, ${validatedData.address.country}`.trim() : undefined,
        dateOfBirth: validatedData.dob,
        idNumber: validatedData.custom_fields?.id_number || (validatedData as any).id_number || (validatedData.custom_fields?.tax_id as string),
      });

      res.status(201).json({
        success: true,
        data: {
          applicant_id: applicant.id,
          status: "created",
          created_at: applicant.created_at,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          error: "Validation error",
        });
      }

      console.error("Create applicant error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : "Unknown error",
        {
          error: "Failed to create KYC applicant",
        },
      );
    }
  };

  /**
   * Get applicant details
   * GET /api/kyc/applicants/:applicantId
   */
  getApplicant = async (req: Request, res: Response) => {
    try {
      const { applicantId } = req.params;
      const userId = req.jwtUser?.userId;

      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      // Verify user owns this applicant
      const hasAccess = await this.verifyApplicantAccess(userId, applicantId);
      if (!hasAccess) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "Access denied",
        });
      }

      const applicant = await this.kycService.getApplicant(applicantId);

      res.json({
        success: true,
        data: applicant,
      });
    } catch (error) {
      console.error("Get applicant error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : "Unknown error",
        {
          error: "Failed to retrieve applicant",
        },
      );
    }
  };

  /**
   * Upload document for verification
   * POST /api/kyc/documents
   */
  uploadDocument = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const validatedData = UploadDocumentSchema.parse(req.body);

      // Verify user owns this applicant
      const hasAccess = await this.verifyApplicantAccess(
        userId,
        validatedData.applicant_id,
      );
      if (!hasAccess) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "Access denied",
        });
      }

      const document = await this.kycService.uploadDocument(validatedData);

      res.status(201).json({
        success: true,
        data: {
          document_id: document.id,
          applicant_id: validatedData.applicant_id,
          status: "uploaded",
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          error: "Validation error",
          details: error.issues,
        });
      }

      console.error("Upload document error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : "Unknown error",
        {
          error: "Failed to upload document",
        },
      );
    }
  };

  /**
   * Create workflow run for comprehensive verification
   * POST /api/kyc/workflow-runs
   */
  createWorkflowRun = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const validatedData = CreateWorkflowRunSchema.parse(req.body);

      // Verify user owns this applicant
      const hasAccess = await this.verifyApplicantAccess(
        userId,
        validatedData.applicant_id,
      );
      if (!hasAccess) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "Access denied",
        });
      }

      const workflowRun = await this.kycService.createWorkflowRun(
        validatedData.applicant_id,
        validatedData.workflow_id,
      );

      res.status(201).json({
        success: true,
        data: {
          workflow_run_id: workflowRun.id,
          applicant_id: validatedData.applicant_id,
          status: workflowRun.status,
          created_at: workflowRun.created_at,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.issues,
          error: "Validation error",
        });
      }

      console.error("Create workflow run error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create workflow run",
        {
          message: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  };

  /**
   * Generate SDK token for client-side integration
   * POST /api/kyc/sdk-token
   */
  generateSDKToken = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const validatedData = GenerateSDKTokenSchema.parse(req.body);

      // Verify user owns this applicant
      const hasAccess = await this.verifyApplicantAccess(
        userId,
        validatedData.applicant_id,
      );
      if (!hasAccess) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "Access denied",
        });
      }

      const sdkToken = await this.kycService.generateSDKToken(
        validatedData.applicant_id,
        validatedData.application_id,
      );

      res.json({
        success: true,
        data: {
          sdk_token: sdkToken,
          applicant_id: validatedData.applicant_id,
          application_id: validatedData.application_id,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.issues,
        });
      }

      console.error("Generate SDK token error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to generate SDK token",
        {
          message: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  };

  /**
   * Get verification status for an applicant
   * GET /api/kyc/applicants/:applicantId/status
   */
  getVerificationStatus = async (req: Request, res: Response) => {
    try {
      const { applicantId } = req.params;
      const userId = req.jwtUser?.userId;

      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      // Verify user owns this applicant
      const hasAccess = await this.verifyApplicantAccess(userId, applicantId);
      if (!hasAccess) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "Access denied",
        });
      }

      const verificationStatus =
        await this.kycService.getVerificationStatus(applicantId);

      res.json({
        success: true,
        data: verificationStatus,
      });
    } catch (error) {
      console.error("Get verification status error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to get verification status",
        {
          message: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  };

  /**
   * Get user's KYC status and transaction limits
   * GET /api/kyc/status
   */
 getUserKYCStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.jwtUser?.userId;
    if (!userId) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
        error: "User not authenticated",
      });
    }

    // Get user's current KYC level from database
    const userQuery = `
      SELECT kyc_level FROM users WHERE id = $1
    `;
    const userResult = await this.db.query(userQuery, [userId]);

    if (userResult.rows.length === 0) {
      throw createError(ERROR_CODES.NOT_FOUND, "User not found", {
        error: "User not found",
      });
    }

    const currentKYCLevel = userResult.rows[0].kyc_level as KYCLevel;
    const transactionLimits =
      this.kycService.getTransactionLimits(currentKYCLevel);

    // Get latest KYC applicant data if exists
    const applicantQuery = `
      SELECT applicant_id, verification_status, kyc_level, updated_at
      FROM kyc_applicants 
      WHERE user_id = $1 
      ORDER BY updated_at DESC 
      LIMIT 1
    `;
    const applicantResult = await this.db.query(applicantQuery, [userId]);

    res.json({
      success: true,
      data: {
        current_kyc_level: currentKYCLevel,
        transaction_limits: transactionLimits,
        latest_verification: applicantResult.rows[0] || null,
      },
    });
  } catch (error) {
    console.error("Get user KYC status error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to get KYC status", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

  /**
   * Handle webhook events from KYC provider
   * POST /api/kyc/webhooks
   */
  handleWebhook = async (req: Request, res: Response) => {
    try {
      const webhookSecret = process.env.KYC_WEBHOOK_SECRET;
      const signature = req.headers["x-onfido-signature"] as string | undefined;

      if (webhookSecret && signature) {
        const payload = this.getRawBody(req);
        const isValid = this.verifyWebhookSignature(payload, signature, webhookSecret);

        if (!isValid) {
          logger.warn({ signature, headers: req.headers }, 'Invalid webhook signature');
          throw createError(
            ERROR_CODES.UNAUTHORIZED,
            "Invalid webhook signature"
          );
        }
      }

      const event = req.body;
      await this.kycService.handleWebhook(event);

      res.status(200).json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Handle webhook error');
      if ((error as any)?.statusCode) {
        throw error;
      }
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to handle webhook", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  /**
   * Verify webhook signature using HMAC-SHA256
   * @param payload - The raw request body as a string
   * @param signature - The signature from x-onfido-signature header
   * @param secret - The webhook secret
   * @returns true if signature is valid, false otherwise
   */
  private verifyWebhookSignature(
    payload: string,
    signature: string,
    secret: string
  ): boolean {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      if (signature.length !== expectedSignature.length) {
        return false;
      }

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      logger.error({ error }, 'Error verifying webhook signature');
      return false;
    }
  }

  private getRawBody(req: Request): string {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    return rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
  }

  // Private helper methods

  private async storeApplicantReference(
    userId: string,
    applicantId: string,
  ): Promise<void> {
    try {
      const query = `
        INSERT INTO kyc_applicants (user_id, applicant_id, provider, verification_status, kyc_level)
        VALUES ($1, $2, 'entrust', 'pending', 'none')
        ON CONFLICT (user_id, applicant_id) DO NOTHING
      `;

      await this.db.query(query, [userId, applicantId]);
    } catch (error) {
      console.error("Failed to store applicant reference:", error);
      throw error;
    }
  }

  private async verifyApplicantAccess(
    userId: string,
    applicantId: string,
  ): Promise<boolean> {
    try {
      const query = `
        SELECT 1 FROM kyc_applicants 
        WHERE user_id = $1 AND applicant_id = $2
        LIMIT 1
      `;

      const result = await this.db.query(query, [userId, applicantId]);
      return result.rows.length > 0;
    } catch (error) {
      console.error("Failed to verify applicant access:", error);
      return false;
    }
  }
}

export default KYCController;