/**
 * SEP-12 customer route handlers and document upload validation middleware.
 *
 * Implements:
 *   - Multipart/form-data upload validation with strict MIME type and magic-byte screening
 *   - 5MB maximum file size enforcement per document
 *   - Encrypted document references for secure object storage
 *   - Customer data deletion (GDPR / NDPR right to erasure)
 */

import { NextFunction, Request, RequestHandler, Response } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { CustomerDataMaskingService } from "../services/customerDataMaskingService";
import logger from "../utils/logger";

type Anonymizer = Pick<CustomerDataMaskingService, "anonymizeByStellarAccount">;

export const SEP12_MAX_DOCUMENT_SIZE = 5 * 1024 * 1024; // 5MB limit per document

export const SEP12_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
];

export const SEP12_ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".pdf"];

/**
 * Validates magic bytes to ensure file contents match declared MIME type.
 * Protects against disguised executables, malware, and malformed binary files.
 */
export function validateDocumentMagicBytes(
  buffer: Buffer,
  mimetype: string,
): boolean {
  if (!buffer || buffer.length < 4) return false;

  const normalizedMime = mimetype.toLowerCase().trim();

  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  if (normalizedMime === "application/pdf") {
    return (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    );
  }

  // PNG: \x89PNG\r\n\x1a\n (0x89 0x50 0x4E 0x47)
  if (normalizedMime === "image/png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }

  // JPEG / JPG: 0xFF 0xD8 0xFF
  if (normalizedMime === "image/jpeg" || normalizedMime === "image/jpg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  return false;
}

/**
 * Encrypts document data for secure object storage and returns a reference.
 */
export function storeEncryptedDocumentReference(
  fileBuffer: Buffer,
  originalFilename: string,
  mimetype: string,
): string {
  const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const encryptionKey =
    process.env.KYC_DOCUMENT_ENCRYPTION_KEY ||
    process.env.APP_SECRET ||
    "0123456789abcdef0123456789abcdef"; // 32-byte key fallback
  const key = crypto.createHash("sha256").update(encryptionKey).digest();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  const refPayload = {
    docId: `doc_${hash.substring(0, 16)}`,
    hash,
    filename: originalFilename,
    mimetype,
    size: fileBuffer.length,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    storageRef: `vault://kyc-documents/${hash.substring(0, 2)}/${hash}.enc`,
    ciphertext: encrypted.toString("base64"),
  };

  return `enc_ref:${Buffer.from(JSON.stringify(refPayload)).toString("base64")}`;
}

const memoryStorage = multer.memoryStorage();

const sep12Multer = multer({
  storage: memoryStorage,
  limits: {
    fileSize: SEP12_MAX_DOCUMENT_SIZE,
    files: 5,
  },
});

/**
 * Middleware handling multipart binary file uploads on SEP-12 PUT /customer
 * with strict 5MB size limit, MIME type validation, and magic byte screening.
 */
export function sep12DocumentUploadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  sep12Multer.any()(req, res, (err: any) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: "File size exceeds 5MB limit",
          message: "Maximum document file size allowed is 5MB",
        });
      }
      return res.status(400).json({
        error: "File upload error",
        message: err.message || "Invalid multipart upload",
      });
    }

    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.body = req.body || {};

      for (const file of req.files as Express.Multer.File[]) {
        // Enforce 5MB limit check explicitly
        if (file.size > SEP12_MAX_DOCUMENT_SIZE) {
          return res.status(400).json({
            error: "File size exceeds 5MB limit",
            message: `Document '${file.fieldname}' exceeds the 5MB size limit`,
          });
        }

        const ext = path.extname(file.originalname).toLowerCase();
        const mime = file.mimetype.toLowerCase();

        // Check allowed MIME types
        if (!SEP12_ALLOWED_MIME_TYPES.includes(mime)) {
          return res.status(400).json({
            error: "Unsupported MIME type",
            message: `Unsupported file type '${file.mimetype}'. Allowed types: image/jpeg, image/png, application/pdf`,
          });
        }

        // Magic byte verification for malware / malformed payload screening
        const isValidMagic = validateDocumentMagicBytes(file.buffer, mime);
        if (!isValidMagic) {
          logger.warn(
            { fieldname: file.fieldname, mime, size: file.size },
            "SECURITY ALERT: Rejected file upload failing magic byte verification",
          );
          return res.status(400).json({
            error: "Invalid file content",
            message: `Document '${file.fieldname}' content does not match declared MIME type ${file.mimetype}`,
          });
        }

        // Store encrypted document reference
        const encryptedRef = storeEncryptedDocumentReference(
          file.buffer,
          file.originalname,
          file.mimetype,
        );

        req.body[file.fieldname] = encryptedRef;
      }
    }

    next();
  });
}

export function createDeleteCustomerHandler(
  maskingService: Anonymizer,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { account } = req.params;

    if (!account || !StrKey.isValidEd25519PublicKey(account)) {
      return next(
        createError(ERROR_CODES.INVALID_INPUT, "Invalid Stellar account", {
          error: "account must be a valid Stellar public key",
        }),
      );
    }

    try {
      const result = await maskingService.anonymizeByStellarAccount(account);

      if (!result) {
        return next(
          createError(ERROR_CODES.NOT_FOUND, "Customer not found", {
            error: "Customer not found",
          }),
        );
      }

      res.status(200).json({
        status: "anonymized",
        account,
        anonymized_at: result.anonymizedAt,
        already_anonymized: result.alreadyAnonymized,
        retained_transactions: result.retainedTransactions,
      });
    } catch (error) {
      logger.error({ err: error }, "[SEP-12] Error anonymizing customer");
      next(
        createError(
          ERROR_CODES.INTERNAL_ERROR,
          "Failed to delete customer information",
          { error: "Failed to delete customer information" },
        ),
      );
    }
  };
}
