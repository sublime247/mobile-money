import logger from "../utils/logger";
import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  getS3Client,
  s3Config,
  getS3ObjectUrl,
  getS3BucketTargets,
} from "../config/s3";

type S3BucketTarget = {
  bucket: string;
  region: string;
  client: { send: (command: any) => Promise<any> };
  isReplica: boolean;
};
import {
  generateUniqueFilename,
  generateDisputeS3Key,
} from "../middleware/disputeUpload";

export interface DisputeUploadResult {
  success: boolean;
  fileUrl?: string;
  key?: string;
  error?: string;
}

export interface DisputeUploadOptions {
  disputeId: string;
  file: Express.Multer.File;
  uploadedBy: string;
  metadata?: Record<string, string>;
}

/**
 * Upload dispute evidence file to S3 bucket
 */
export const uploadDisputeEvidenceToS3 = async (
  options: DisputeUploadOptions,
): Promise<DisputeUploadResult> => {
  try {
    const { disputeId, file, uploadedBy, metadata = {} } = options;

    // Generate unique filename and S3 key
    const uniqueFilename = generateUniqueFilename(file.originalname);
    const key = generateDisputeS3Key(disputeId, uniqueFilename);

    const s3Client = getS3Client();

    // Prepare upload command
    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ServerSideEncryption: "AES256",
      Metadata: {
        originalName: file.originalname,
        disputeId: disputeId,
        uploadedBy: uploadedBy,
        uploadedAt: new Date().toISOString(),
        fileSize: file.size.toString(),
        ...metadata,
      },
    });

    // Upload to S3
    await s3Client.send(command);

    // Generate public URL
    const fileUrl = getS3ObjectUrl(key);

    return {
      success: true,
      fileUrl,
      key,
    };
  } catch (error) {
    logger.error("S3 dispute evidence upload error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown upload error",
    };
  }
};

/**
 * Upload multiple dispute evidence files to S3
 */
export const uploadMultipleDisputeEvidenceToS3 = async (
  disputeId: string,
  files: Express.Multer.File[],
  uploadedBy: string,
  metadata?: Record<string, string>,
): Promise<DisputeUploadResult[]> => {
  const results: DisputeUploadResult[] = [];

  for (const file of files) {
    const result = await uploadDisputeEvidenceToS3({
      disputeId,
      file,
      uploadedBy,
      metadata,
    });
    results.push(result);
  }

  return results;
};

/**
 * Check if dispute evidence file exists in primary or replica S3 bucket.
 */
export const disputeEvidenceExistsInS3 = async (
  key: string,
  targets: S3BucketTarget[] = getS3BucketTargets(),
): Promise<boolean> => {
  for (const target of targets) {
    try {
      const command = new HeadObjectCommand({ Bucket: target.bucket, Key: key });
      await target.client.send(command);
      return true;
    } catch (error) {
      logger.warn("Dispute S3 head check failed for bucket target", {
        bucket: target.bucket,
        isReplica: target.isReplica,
        key,
      });
    }
  }
  return false;
};

/**
 * Get dispute evidence URL, falling back to replica when primary read fails.
 */
export const getDisputeEvidenceObjectUrl = async (
  key: string,
  targets: S3BucketTarget[] = getS3BucketTargets(),
): Promise<string> => {
  let lastError: unknown;
  for (const target of targets) {
    try {
      const command = new HeadObjectCommand({ Bucket: target.bucket, Key: key });
      await target.client.send(command);
      return getS3ObjectUrl(key, target.bucket, target.region);
    } catch (error) {
      lastError = error;
      logger.warn("Dispute S3 read failed for bucket target", {
        bucket: target.bucket,
        isReplica: target.isReplica,
        key,
      });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Dispute evidence object not found");
};

/**
 * Validate dispute evidence file before upload
 */
export const validateDisputeEvidenceFile = (
  file: Express.Multer.File,
): { valid: boolean; error?: string } => {
  const allowedMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
  ];
  const allowedExtensions = [".pdf", ".jpeg", ".jpg", ".png"];
  const maxSize = 10 * 1024 * 1024;
  const filename = String(file.originalname || "").toLowerCase();

  const hasAllowedMimeType = allowedMimeTypes.includes(file.mimetype);
  const hasAllowedExtension = allowedExtensions.some((ext) =>
    filename.endsWith(ext),
  );

  if (!hasAllowedMimeType || !hasAllowedExtension) {
    return {
      valid: false,
      error: `Invalid file type or extension. Allowed types: PDF, JPG, PNG only`,
    };
  }

  if (file.size > maxSize) {
    return {
      valid: false,
      error: `File size exceeds maximum limit of ${maxSize / (1024 * 1024)}MB`,
    };
  }

  return { valid: true };
};
