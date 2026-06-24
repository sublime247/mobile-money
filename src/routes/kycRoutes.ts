import logger from "../utils/logger";
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
import { createFileSignerFromEnv, KmsFileSigner, FileSignature } from "../services/stellar/hsmService";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, s3Config } from "../config/s3";

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
      logger.error("Document upload error:", error);

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
          s3_key,
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
      const documents = await Promise.all(
        result.rows.map(async (row) => {
          const doc = maskFileUrl(row, canViewRaw);
          let hsmSigned = false;
          if (row.s3_key) {
            try {
              const s3Client = getS3Client();
              const head = await s3Client.send(
                new GetObjectCommand({
                  Bucket: s3Config.bucket,
                  Key: row.s3_key,
                }),
              );
              hsmSigned = !!head.Metadata?.["hsm-signature"];
            } catch {
              // S3 object not accessible — skip verification status
            }
          }
          return { ...doc, hsm_signed: hsmSigned };
        }),
      );

      res.json({
        success: true,
        data: documents,
      });
    } catch (error) {
      logger.error("Get documents error:", error);
      if ((error as any).statusCode) {
        throw error;
      }
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve documents", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

  // Verify HSM signature for a specific document
 router.get(
  "/documents/:id/verify",
  async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
          error: "User not authenticated",
        });
      }

      const { id } = req.params;

      const docQuery = `
        SELECT s3_key, original_filename, file_size
        FROM kyc_documents
        WHERE id = $1 AND user_id = $2
      `;
      const docResult = await db.query(docQuery, [id, userId]);
      if (docResult.rows.length === 0) {
        throw createError(ERROR_CODES.NOT_FOUND, "Document not found", {
          error: "Document not found",
        });
      }

      const s3Key = docResult.rows[0].s3_key;
      if (!s3Key) {
        return res.json({ success: true, data: { verified: false, reason: "No S3 key stored" } });
      }

      // Fetch the file and its metadata from S3
      const s3Client = getS3Client();
      const s3Object = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3Config.bucket,
          Key: s3Key,
        }),
      );

      const meta = s3Object.Metadata ?? {};
      const storedSignature = meta["hsm-signature"];
      const storedKeyId = meta["hsm-key-id"];
      const storedAlgorithm = meta["hsm-algorithm"];
      const storedDigest = meta["hsm-digest"];
      const storedSignedAt = meta["hsm-signed-at"];

      if (!storedSignature || !storedKeyId || !storedAlgorithm) {
        return res.json({
          success: true,
          data: { verified: false, reason: "No HSM signature found on stored object" },
        });
      }

      // Read the full file body
      const bodyStream = s3Object.Body;
      if (!bodyStream) {
        return res.json({ success: true, data: { verified: false, reason: "Unable to read file content" } });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of bodyStream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);

      // Build FileSignature from stored metadata
      const fileSignature: FileSignature = {
        signature: storedSignature,
        keyId: storedKeyId,
        algorithm: storedAlgorithm,
        digest: storedDigest || "",
        signedAt: storedSignedAt || "",
      };

      // Verify using KMS
      const fileSigner = createFileSignerFromEnv();
      if (!fileSigner) {
        return res.json({
          success: true,
          data: { verified: false, reason: "HSM file signer not configured (HSM_FILE_KMS_KEY_ID)" },
        });
      }

      const { valid, digestMatch } = await fileSigner.verifyWithDigestCheck(fileBuffer, fileSignature);

      res.json({
        success: true,
        data: {
          verified: valid,
          digest_match: digestMatch,
          algorithm: storedAlgorithm,
          key_id: storedKeyId,
          signed_at: storedSignedAt,
          document_id: id,
        },
      });
    } catch (error) {
      console.error("Document verification error:", error);
      if ((error as any).statusCode) {
        throw error;
      }
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to verify document signature", {
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
