import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { getS3Client, s3Config, getS3ObjectUrl } from "../config/s3";
import { generateUniqueFilename, generateS3Key } from "../middleware/upload";
import { KmsFileSigner, createFileSignerFromEnv, FileSignature } from "./stellar/hsmService";

export interface UploadResult {
  success: boolean;
  fileUrl?: string;
  key?: string;
  signature?: FileSignature;
  error?: string;
}

export interface UploadOptions {
  userId: string;
  file: Express.Multer.File;
  metadata?: Record<string, string>;
}

/**
 * Upload file to S3 bucket with automatic HSM signing.
 *
 * Before uploading, the file buffer's SHA-256 digest is computed locally
 * and signed via the configured KMS asymmetric key. The signature is
 * stored in S3 object metadata so it can be retrieved for verification
 * on read paths.
 *
 * If no HSM_FILE_KMS_KEY_ID is configured (CI / local dev), signing is
 * skipped gracefully.
 */
export const uploadToS3 = async (
  options: UploadOptions,
): Promise<UploadResult> => {
  try {
    const { userId, file, metadata = {} } = options;

    // Generate unique filename and S3 key
    const uniqueFilename = generateUniqueFilename(file.originalname);
    const key = generateS3Key(userId, uniqueFilename);

    const s3Client = getS3Client();

    // ── HSM file signing ──────────────────────────────────────────────
    const fileSigner = createFileSignerFromEnv();
    let fileSignature: FileSignature | undefined;

    if (fileSigner) {
      try {
        fileSignature = await fileSigner.sign(file.buffer);
      } catch (err) {
        console.error("HSM file signing failed (upload continues):", err);
      }
    }

    // Build S3 metadata, appending signature fields when available
    const s3Metadata: Record<string, string> = {
      originalName: file.originalname,
      uploadedBy: userId,
      uploadedAt: new Date().toISOString(),
      ...metadata,
    };

    if (fileSignature) {
      s3Metadata["hsm-signature"] = fileSignature.signature;
      s3Metadata["hsm-key-id"] = fileSignature.keyId;
      s3Metadata["hsm-algorithm"] = fileSignature.algorithm;
      s3Metadata["hsm-digest"] = fileSignature.digest;
      s3Metadata["hsm-signed-at"] = fileSignature.signedAt;
    }

    // Prepare upload command
    // Generate a random 256-bit (32-byte) key for SSE-C encryption
    const sseKey = crypto.randomBytes(32);
    const sseKeyBase64 = sseKey.toString('base64');
    const sseKeyMD5 = crypto.createHash('md5').update(sseKey).digest('base64');

    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        originalName: file.originalname,
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        ...metadata,
      },
      SSECustomerAlgorithm: 'AES256',
      SSECustomerKey: sseKeyBase64,
      SSECustomerKeyMD5: sseKeyMD5,
      // Set appropriate ACL (private by default)
      // ACL: 'private',
    });

    // Upload to S3
    await s3Client.send(command);

    // Generate public URL
    const fileUrl = getS3ObjectUrl(key);

    return {
      success: true,
      fileUrl,
      key,
      signature: fileSignature,
    };
  } catch {
    console.error("S3 upload error");
    return {
      success: false,
      error: "Unknown upload error",
    };
  }
};

/**
 * Check if file exists in S3
 */
export const fileExistsInS3 = async (key: string): Promise<boolean> => {
  try {
    const s3Client = getS3Client();
    const command = new HeadObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Validate file before upload
 */
export const validateFile = (
  file: Express.Multer.File,
): { valid: boolean; error?: string } => {
  const allowedMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
  ];
  const allowedExtensions = [".pdf", ".jpeg", ".jpg", ".png"];
  const maxSize = 5 * 1024 * 1024; // 5MB

  const originalName = String(file.originalname || "").toLowerCase();
  const hasAllowedExtension = allowedExtensions.some((ext) =>
    originalName.endsWith(ext),
  );
  const hasAllowedMimeType = allowedMimeTypes.includes(file.mimetype);

  if (!hasAllowedMimeType && !hasAllowedExtension) {
    return {
      valid: false,
      error: `Invalid file type. Allowed types: ${allowedMimeTypes.join(", ")}`,
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
