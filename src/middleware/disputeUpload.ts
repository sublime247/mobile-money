import multer from 'multer';
import { Request } from 'express';
import crypto from 'crypto';
import path from 'path';

/**
 * Allowed file types and extensions for dispute evidence
 */
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
];

const ALLOWED_EXTENSIONS = ['.pdf', '.jpeg', '.jpg', '.png'];

/**
 * Maximum file size: 10MB
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

/**
 * Maximum number of files per upload
 */
const MAX_FILES = 5;

/**
 * File filter to validate file types
 */
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const hasAllowedMimeType = ALLOWED_MIME_TYPES.includes(file.mimetype);
  const filename = String(file.originalname || '').toLowerCase();
  const hasAllowedExtension = ALLOWED_EXTENSIONS.some((ext) =>
    filename.endsWith(ext),
  );

  if (hasAllowedMimeType && hasAllowedExtension) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type or extension. Allowed types: PDF, JPG, PNG only`
      )
    );
  }
};

/**
 * Generate unique filename with timestamp and random hash
 */
export const generateUniqueFilename = (originalFilename: string): string => {
  const timestamp = Date.now();
  const randomHash = crypto.randomBytes(8).toString('hex');
  const extension = path.extname(originalFilename);
  const basename = path.basename(originalFilename, extension);
  
  // Sanitize basename (remove special characters)
  const sanitizedBasename = basename.replace(/[^a-zA-Z0-9-_]/g, '_');
  
  return `${sanitizedBasename}-${timestamp}-${randomHash}${extension}`;
};

/**
 * Generate S3 key path for dispute evidence
 */
export const generateDisputeS3Key = (disputeId: string, filename: string): string => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  
  return `dispute-evidence/${year}/${month}/${disputeId}/${filename}`;
};

/**
 * Multer memory storage configuration
 * Files are stored in memory temporarily before uploading to S3
 */
const storage = multer.memoryStorage();

/**
 * Multer upload middleware configuration for single file
 */
export const uploadSingle = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
});

/**
 * Multer upload middleware configuration for multiple files
 */
export const uploadMultiple = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
});

/**
 * Error messages for upload validation
 */
export const disputeUploadErrorMessages = {
  FILE_TOO_LARGE: `File size exceeds maximum limit of ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
  INVALID_FILE_TYPE: `Invalid file type. Allowed types: PDF, JPG, PNG only`,
  TOO_MANY_FILES: `Maximum ${MAX_FILES} files allowed per upload`,
  NO_FILE_UPLOADED: 'No file uploaded',
  UPLOAD_FAILED: 'File upload failed',
};