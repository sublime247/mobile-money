import logger from "../utils/logger";
import multer from "multer";
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import path from "path";
import sharp from "sharp";

/**
 * Allowed file types for KYC documents
 */
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
];

/**
 * Maximum file size: 5MB
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes

/**
 * File filter to validate file types
 */
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  // Accept file at middleware stage; route-level validation returns controlled errors.
  cb(null, true);
};

/**
 * Generate unique filename with timestamp and random hash
 */
export const generateUniqueFilename = (originalFilename: string): string => {
  const timestamp = Date.now();
  const randomHash = crypto.randomBytes(8).toString("hex");
  const extension = path.extname(originalFilename);
  const basename = path.basename(originalFilename, extension);

  // Sanitize basename (remove special characters)
  const sanitizedBasename = basename.replace(/[^a-zA-Z0-9-_]/g, "_");

  return `${sanitizedBasename}-${timestamp}-${randomHash}${extension}`;
};

/**
 * Generate S3 key path for KYC documents
 */
export const generateS3Key = (userId: string, filename: string): string => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `kyc-documents/${year}/${month}/${userId}/${filename}`;
};

/**
 * Multer memory storage configuration
 * Files are stored in memory temporarily before uploading to S3
 */
const storage = multer.memoryStorage();

/**
 * Multer upload middleware configuration
 */
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 10, // Increased to allow multiple standard and custom files per request
  },
});

/**
 * Error messages for upload validation
 */
export const uploadErrorMessages = {
  FILE_TOO_LARGE: `File size exceeds maximum limit of ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
  INVALID_FILE_TYPE: `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
  NO_FILE_UPLOADED: "No file uploaded",
  UPLOAD_FAILED: "File upload failed",
};

/**
  Middleware to optimize image with sharp before s3 upload
 */

export const optimizeProfileImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!req.file) {
    res.status(400).json({
      status: "fail",
      message: uploadErrorMessages.NO_FILE_UPLOADED,
    });
    return next();
  }

  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    res.status(400).json({
      status: "fail",
      message: uploadErrorMessages.INVALID_FILE_TYPE,
    });
    return next();
  }

  try {
    const optimizedBuffer = await sharp(req.file.buffer)
      .resize(500, 500, { fit: "cover", position: "center" })
      .webp({ quality: 80 })
      .toBuffer();

    req.file.buffer = optimizedBuffer;
    req.file.mimetype = "image/webp";
    req.file.size = optimizedBuffer.length;

    const originalNameWithoutExt = req.file.originalname.replace(
      /\.[^/.]+$/,
      "",
    );
    req.file.originalname = `${originalNameWithoutExt}.webp`;

    next();
  } catch (error) {
    logger.error("Image optimization error:", error);
    res.status(500).json({ error: "Failed to optimize image before upload" });
  }
};