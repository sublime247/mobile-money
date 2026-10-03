/**
 * Secure Vault storage service for KYC binary documentation.
 * Resolves Issue #2123.
 */

import {
  Sep12BinaryUploadEngine,
  KycDocumentUpload,
  UploadValidationResult,
} from "../middleware/binaryKycUpload";

export class KycDocumentVaultService {
  private vaultIndex = new Map<string, { vaultKey: string; sha256: string; uploadedAt: Date }>();

  async ingestDocument(
    customerAccount: string,
    file: KycDocumentUpload,
  ): Promise<UploadValidationResult> {
    const result = Sep12BinaryUploadEngine.validateAndIngest(customerAccount, file);

    if (result.valid && result.vaultKey && result.sha256) {
      this.vaultIndex.set(result.vaultKey, {
        vaultKey: result.vaultKey,
        sha256: result.sha256,
        uploadedAt: new Date(),
      });
    }

    return result;
  }

  getDocumentMetadata(vaultKey: string) {
    return this.vaultIndex.get(vaultKey) || null;
  }
}
