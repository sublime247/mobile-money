import { Request, Response } from "express";
import crypto from "crypto";
import { Pool } from "pg";
import KYCService, {
  KYCLevel,
  DocumentType,
  type WebhookEvent,
} from "../services/kyc";
import { z } from "zod";
import { UserModel } from "../models/users";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import { validateExpiryDate } from "../utils/validators";
import { getPepCheckService } from "../services/compliance/pepCheck";
import ZkProofService from "../services/compliance/zkProofService";
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
  custom_fields: z.record(z.string(), z.any()).optional(),
});

const UploadDocumentSchema = z
  .object({
    applicant_id: z.string(),
    type: z.nativeEnum(DocumentType),
    side: z.enum(["front", "back"]).optional(),
    filename: z.string().min(1, "Filename is required"),
    data: z.string().min(1, "Document data is required"),
    expiry_date: z.string().optional(),
    expiryDate: z.string().optional(),
    expiration_date: z.string().optional(),
    expirationDate: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const rawDate =
      data.expiry_date ||
      data.expiryDate ||
      data.expiration_date ||
      data.expirationDate;

    if (rawDate !== undefined && rawDate !== null && rawDate !== "") {
      const isValid = validateExpiryDate(rawDate);
      if (!isValid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid expiry date",
          path: [
            data.expiry_date
              ? "expiry_date"
              : data.expiryDate
                ? "expiryDate"
                : "expiry_date",
          ],
        });
      }
    }
  });

const CreateWorkflowRunSchema = z.object({
  applicant_id: z.string(),
  workflow_id: z.string().optional(),
});

const GenerateSDKTokenSchema = z.object({
  applicant_id: z.string(),
  application_id: z.string(),
});

const IssueAddressProofSchema = z.object({
  applicant_id: z.string().min(1, "applicant_id is required"),
  filename: z.string().min(1, "filename is required"),
  mime_type: z.string().min(1, "mime_type is required"),
  utility_bill_data: z.string().min(1, "utility_bill_data is required"),
  provider_reference: z.string().optional(),
});

const VerifyAddressProofSchema = z.object({
  proof_id: z.string().uuid().optional(),
  applicant_id: z.string().optional(),
});

export class KYCController {
  private kycService: KYCService;
  private zkProofService: ZkProofService;
  private db: Pool;
  private userModel: UserModel;

  constructor(db: Pool) {
    this.db = db;
    this.kycService = new KYCService(db);
    this.zkProofService = new ZkProofService(db);
    this.userModel = new UserModel();
  }

  createApplicant = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const validatedData = CreateApplicantSchema.parse(req.body);
      const applicant = await this.kycService.createApplicant(validatedData);
      await this.storeApplicantReference(userId, applicant.id);

      try {
        const pepService = getPepCheckService();
        await pepService.ensureSeeded();
        const pepMatch = await pepService.screenCustomer(
          validatedData.first_name,
          validatedData.last_name,
          validatedData.address?.country || "",
        );

        if (pepMatch.matched) {
          logger.warn("PEP match detected for applicant", {
            applicantId: applicant.id,
            userId,
            score: pepMatch.score,
          });
          await pepService.flagForReview(userId, pepMatch);
        }
      } catch (pepErr) {
        logger.error("Error during PEP screening", { error: (pepErr as Error).message });
      }

      res.status(201).json({
        status: "success",
        data: { applicant },
      });
    } catch (error) {
      logger.error("Error in createApplicant", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  uploadDocument = async (req: Request, res: Response) => {
    try {
      const validatedData = UploadDocumentSchema.parse(req.body);
      const result = await this.kycService.uploadDocument(validatedData);
      res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (error) {
      logger.error("Error in uploadDocument", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  retryUploadDocument = async (req: Request, res: Response) => {
    try {
      const validatedData = UploadDocumentSchema.parse(req.body);
      logger.info("Cleaning old files from S3/vault storage for retry upload", {
        applicant_id: validatedData.applicant_id,
        type: validatedData.type,
      });

      try {
        await this.db.query(
          "DELETE FROM kyc_documents WHERE applicant_id = $1 AND document_type = $2",
          [validatedData.applicant_id, validatedData.type]
        );
      } catch (dbCleanErr) {
        logger.warn("Failed to clean previous document records during retry", {
          error: (dbCleanErr as Error).message,
        });
      }

      const result = await this.kycService.uploadDocument(validatedData);
      res.status(200).json({
        status: "success",
        message: "Document re-uploaded successfully after storage cleanup",
        data: result,
      });
    } catch (error) {
      logger.error("Error in retryUploadDocument", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  createWorkflowRun = async (req: Request, res: Response) => {
    try {
      const validatedData = CreateWorkflowRunSchema.parse(req.body);
      const workflowRun = await this.kycService.createWorkflowRun(
        validatedData.applicant_id,
        validatedData.workflow_id
      );
      res.status(201).json({
        status: "success",
        data: { workflow_run: workflowRun },
      });
    } catch (error) {
      logger.error("Error in createWorkflowRun", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  getVerificationStatus = async (req: Request, res: Response) => {
    try {
      const { applicant_id } = req.params;
      if (!applicant_id) {
        throw createError(ERROR_CODES.MISSING_FIELD, "Applicant ID is required");
      }
      const status = await this.kycService.getVerificationStatus(applicant_id);
      res.status(200).json({
        status: "success",
        data: status,
      });
    } catch (error) {
      logger.error("Error in getVerificationStatus", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  generateSDKToken = async (req: Request, res: Response) => {
    try {
      const validatedData = GenerateSDKTokenSchema.parse(req.body);
      const token = await this.kycService.generateSDKToken(
        validatedData.applicant_id,
        validatedData.application_id
      );
      res.status(200).json({
        status: "success",
        data: { token },
      });
    } catch (error) {
      logger.error("Error in generateSDKToken", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  issueAddressProof = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated");
      }
      const result = await this.zkProofService.issueAddressProof(userId, req.body);
      res.status(201).json({
        status: "success",
        data: result,
      });
    } catch (error) {
      logger.error("Error in issueAddressProof", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  verifyAddressProof = async (req: Request, res: Response) => {
    try {
      const validated = VerifyAddressProofSchema.parse(req.body);
      const userId = (req as any).user?.id || (req.body as any).userId || "";
      const result = await this.zkProofService.verifyAddressProof(userId, validated);
      res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (error) {
      logger.error("Error in verifyAddressProof", { error: (error as Error).message });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  handleWebhook = async (req: Request, res: Response) => {
    try {
      const event = req.body as WebhookEvent;
      if (!event?.payload?.action || !event?.payload?.object) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Invalid KYC webhook payload",
          { error: "Invalid KYC webhook payload" },
        );
      }

      await this.kycService.handleWebhook(event);
      res.status(200).json({ status: "success" });
    } catch (error) {
      logger.error("Error in handleWebhook", {
        error: (error as Error).message,
      });
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({
        status: "error",
        message: (error as Error).message,
        code: (error as any).code || ERROR_CODES.INTERNAL_ERROR,
      });
    }
  };

  getApplicant = async (req: Request, res: Response) => {
    return this.getVerificationStatus(req, res);
  };

  getUserKYCStatus = async (req: Request, res: Response) => {
    return this.getVerificationStatus(req, res);
  };

  issueZkCredential = async (req: Request, res: Response) => {
    return this.issueAddressProof(req, res);
  };

  verifyZkProof = async (req: Request, res: Response) => {
    return this.verifyAddressProof(req, res);
  };

  private async storeApplicantReference(userId: string, applicantId: string): Promise<void> {
    try {
      await this.db.query(
        "UPDATE users SET kyc_applicant_id = $1, updated_at = NOW() WHERE id = $2",
        [applicantId, userId]
      );
    } catch (err) {
      logger.warn("Failed to store applicant reference on user record", {
        error: (err as Error).message,
      });
    }
  }
}
