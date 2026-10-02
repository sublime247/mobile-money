/**
 * SEP-12: Binary KYC Document Upload Validation Middleware
 * Resolves Issue #2123: Validates multipart document uploads with magic-byte screening,
 * size constraints (5MB max), and secure vault tokenization.
 */
import crypto from "crypto";

export const MAX_KYC_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export interface KycDocumentUpload {
  fieldName: "photo_id_front" | "photo_id_back" | "proof_of_address";
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface UploadValidationResult {
  valid: boolean;
  errorCode?: "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "SPOOFED_MAGIC_BYTES";
  errorMessage?: string;
  vaultKey?: string;
  sha256?: string;
}

export class Sep12BinaryUploadEngine {
  private static readonly MAGIC_BYTES: Record<string, number[]> = {
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/png": [0x89, 0x50, 0x4e, 0x47],
    "application/pdf": [0x25, 0x50, 0x44, 0x46], // %PDF
  };

  static validateAndIngest(
    customerAccount: string,
    file: KycDocumentUpload,
  ): UploadValidationResult {
    // 1. File size check (5MB limit)
    if (file.buffer.length > MAX_KYC_FILE_SIZE) {
      return {
        valid: false,
        errorCode: "PAYLOAD_TOO_LARGE",
        errorMessage: `File size ${file.buffer.length} exceeds 5MB limit.`,
      };
    }

    // 2. MIME type whitelist check
    const expectedMagic = this.MAGIC_BYTES[file.mimeType];
    if (!expectedMagic) {
      return {
        valid: false,
        errorCode: "UNSUPPORTED_MEDIA_TYPE",
        errorMessage: `MIME type ${file.mimeType} is not supported. Allowed: image/jpeg, image/png, application/pdf.`,
      };
    }

    // 3. Magic bytes screening
    if (file.buffer.length < expectedMagic.length) {
      return {
        valid: false,
        errorCode: "SPOOFED_MAGIC_BYTES",
        errorMessage: "File buffer too short to contain magic bytes.",
      };
    }

    for (let i = 0; i < expectedMagic.length; i++) {
      if (file.buffer[i] !== expectedMagic[i]) {
        return {
          valid: false,
          errorCode: "SPOOFED_MAGIC_BYTES",
          errorMessage: `File header magic bytes do not match declared MIME type ${file.mimeType}.`,
        };
      }
    }

    // 4. Secure Vault Reference Generation
    const sha256 = crypto
      .createHash("sha256")
      .update(file.buffer)
      .digest("hex");
    const vaultKey = `kyc-vault/${customerAccount.substring(0, 12)}/${file.fieldName}_${sha256.substring(0, 16)}`;

    return {
      valid: true,
      sha256,
      vaultKey,
    };
  }
}
