import { NextFunction, Router } from "express";
import { Pool } from "pg";
import { KYCController } from "../controllers/kycController";
import { authenticateToken } from "../middleware/auth";
import { upload, uploadErrorMessages } from "../middleware/upload";
import { uploadToS3 } from "../services/s3Upload";
import KYCService, { DocumentType } from "../services/kyc";
import { Request, Response } from "express";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const COMPLIANCE_OFFICER_ROLE = "compliance_officer";
const REDACTED_FILE_URL = "[REDACTED]";

function validateUploadFile(file: Express.Multer.File): {
  valid: boolean;
  error?: string;
} {
  const allowedMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
  ];
  const allowedExtensions = [".pdf", ".jpeg", ".jpg", ".png"];
  const maxSize = 5 * 1024 * 1024;
  const filename = String(file.originalname || "").toLowerCase();

  const hasAllowedMimeType = allowedMimeTypes.includes(file.mimetype);
  const hasAllowedExtension = allowedExtensions.some((ext) =>
    filename.endsWith(ext),
  );

  if (!hasAllowedMimeType && !hasAllowedExtension) {
    return {
      valid: false,
      error: uploadErrorMessages.INVALID_FILE_TYPE,
    };
  }

  if (file.size > maxSize) {
    return {
      valid: false,
      error: uploadErrorMessages.FILE_TOO_LARGE,
    };
  }

  return { valid: true };
}

function canViewRawKycUploads(req: Request): boolean {
  return req.jwtUser?.role === COMPLIANCE_OFFICER_ROLE;
}

function maskFileUrl<T extends { file_url?: string | null }>(
  document: T,
  canViewRaw: boolean,
): T {
  if (canViewRaw || !document.file_url) {
    return document;
  }

  return {
    ...document,
    file_url: REDACTED_FILE_URL,
  };
}

function annotateDocumentVisibility(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.locals.canViewRawKycUploads = canViewRawKycUploads(req);
  next();
}

export const createKYCRoutes = (db: Pool): Router => {
  const router = Router();
  const kycController = new KYCController(db);
  const kycService = new KYCService(db);

  // Webhook endpoint (no auth required - verified by signature)
  router.post("/webhooks", kycController.handleWebhook);

  // All remaining KYC routes require authentication
  router.use(authenticateToken);

  // Applicant management
  router.post("/applicants", kycController.createApplicant);
  router.get("/applicants/:applicantId", kycController.getApplicant);
  router.get(
    "/applicants/:applicantId/status",
    kycController.getVerificationStatus,
  );

  // Document upload (legacy - base64)
  router.post("/documents", kycController.uploadDocument);

  // File upload to S3
 router.post(
  "/documents/upload",
  annotateDocumentVisibility,
  upload.single("document"),
  async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      // Get required metadata from request body first
      const { applicant_id, document_type, document_side } = req.body;

      if (!applicant_id) {
        throw createError(ERROR_CODES.INVALID_INPUT, "applicant_id is required", {
          error: "applicant_id is required",
        });
      }

      // Check if file was uploaded
      if (!req.file) {
        throw createError(ERROR_CODES.INVALID_INPUT, uploadErrorMessages.NO_FILE_UPLOADED, {
          error: uploadErrorMessages.NO_FILE_UPLOADED,
        });
      }

      // Validate file
      const validation = validateUploadFile(req.file);
      if (!validation.valid) {
        throw createError(ERROR_CODES.INVALID_INPUT, validation.error, {
          error: validation.error,
        });
      }

      // Verify user owns this applicant
      const accessQuery = `
        SELECT 1 FROM kyc_applicants 
        WHERE user_id = $1 AND applicant_id = $2
        LIMIT 1
      `;
      const accessResult = await db.query(accessQuery, [
        userId,
        applicant_id,
      ]);

      if (accessResult.rows.length === 0) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "Access denied",
        });
      }

      // Upload to S3
      const uploadResult = await uploadToS3({
        userId,
        file: req.file,
        metadata: {
          applicantId: applicant_id,
          documentType: document_type || "unknown",
          documentSide: document_side || "front",
        },
      });

      if (!uploadResult.success) {
        throw createError(ERROR_CODES.INTERNAL_ERROR, uploadErrorMessages.UPLOAD_FAILED, {
          error: uploadErrorMessages.UPLOAD_FAILED,
          details: uploadResult.error,
        });
      }

      // Store document reference in database
      const insertQuery = `
        INSERT INTO kyc_documents (
          user_id, 
          applicant_id, 
          document_type, 
          document_side, 
          file_url, 
          s3_key, 
          original_filename,
          file_size,
          mime_type
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, file_url, created_at
      `;

      const documentResult = await db.query(insertQuery, [
        userId,
        applicant_id,
        document_type || "unknown",
        document_side || "front",
        uploadResult.fileUrl,
        uploadResult.key,
        req.file.originalname,
        req.file.size,
        req.file.mimetype,
      ]);

      const providerDocument = await kycService.uploadDocumentBinary({
        applicant_id,
        type: (document_type || "passport") as DocumentType,
        side: document_side === "back" ? "back" : "front",
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        fileBuffer: req.file.buffer,
      });

      const canViewRaw = Boolean(res.locals.canViewRawKycUploads);

      res.status(201).json({
        success: true,
        data: {
          document_id: documentResult.rows[0].id,
          provider_document_id: providerDocument?.id,
          file_url: canViewRaw
            ? documentResult.rows[0].file_url
            : REDACTED_FILE_URL,
          applicant_id,
          uploaded_at: documentResult.rows[0].created_at,
        },
      });
    } catch (error) {
      console.error("Document upload error:", error);

      if ((error as any).statusCode) {
        throw error;
      }

      // Handle multer errors
      if (error instanceof Error) {
        if (error.message.includes("File too large")) {
          throw createError(ERROR_CODES.INVALID_INPUT, uploadErrorMessages.FILE_TOO_LARGE, {
            error: uploadErrorMessages.FILE_TOO_LARGE,
          });
        }
        if (error.message.includes("Invalid file type")) {
          throw createError(ERROR_CODES.INVALID_INPUT, uploadErrorMessages.INVALID_FILE_TYPE, {
            error: uploadErrorMessages.INVALID_FILE_TYPE,
          });
        }
      }

      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to upload document", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

  // Get user's uploaded documents
 router.get(
  "/documents",
  annotateDocumentVisibility,
  async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const query = `
        SELECT 
          id,
          applicant_id,
          document_type,
          document_side,
          file_url,
          original_filename,
          file_size,
          mime_type,
          created_at
        FROM kyc_documents
        WHERE user_id = $1
        ORDER BY created_at DESC
      `;

      const result = await db.query(query, [userId]);
      const canViewRaw = Boolean(res.locals.canViewRawKycUploads);
      const documents = result.rows.map((row) =>
        maskFileUrl(row, canViewRaw),
      );

      res.json({
        success: true,
        data: documents,
      });
    } catch (error) {
      console.error("Get documents error:", error);
      if ((error as any).statusCode) {
        throw error;
      }
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve documents", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

  // Workflow management
  router.post("/workflow-runs", kycController.createWorkflowRun);

  // SDK token generation
  router.post("/sdk-token", kycController.generateSDKToken);

  // User KYC status
  router.get("/status", kycController.getUserKYCStatus);

  return router;
};

export default createKYCRoutes;
