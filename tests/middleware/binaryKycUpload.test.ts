import {
  Sep12BinaryUploadEngine,
  KycDocumentUpload,
} from "../../src/middleware/binaryKycUpload";
import { KycDocumentVaultService } from "../../src/services/kycDocumentVault";

describe("SEP-12 Binary KYC Document Upload (Issue #2123)", () => {
  const customerStellarAccount = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  let vaultService: KycDocumentVaultService;

  beforeEach(() => {
    vaultService = new KycDocumentVaultService();
  });

  it("should accept valid JPEG document with correct magic bytes within 5MB", async () => {
    // JPEG header: FF D8 FF E0
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const upload: KycDocumentUpload = {
      fieldName: "photo_id_front",
      originalName: "passport_front.jpg",
      mimeType: "image/jpeg",
      buffer: jpegBuffer,
    };

    const result = await vaultService.ingestDocument(customerStellarAccount, upload);
    expect(result.valid).toBe(true);
    expect(result.vaultKey).toContain("photo_id_front_");
    expect(result.sha256).toBeDefined();

    const metadata = vaultService.getDocumentMetadata(result.vaultKey!);
    expect(metadata).not.toBeNull();
    expect(metadata?.sha256).toBe(result.sha256);
  });

  it("should accept valid PDF document with %PDF magic bytes", async () => {
    const pdfBuffer = Buffer.from("%PDF-1.4 header content here with fake data", "utf-8");
    const upload: KycDocumentUpload = {
      fieldName: "proof_of_address",
      originalName: "utility_bill.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    };

    const result = await vaultService.ingestDocument(customerStellarAccount, upload);
    expect(result.valid).toBe(true);
    expect(result.vaultKey).toContain("proof_of_address_");
  });

  it("should reject file exceeding 5MB limit with PAYLOAD_TOO_LARGE", async () => {
    const oversizedBuffer = Buffer.alloc(5 * 1024 * 1024 + 1024); // 5MB + 1KB
    oversizedBuffer[0] = 0x89;
    oversizedBuffer[1] = 0x50;
    oversizedBuffer[2] = 0x4e;
    oversizedBuffer[3] = 0x47;

    const upload: KycDocumentUpload = {
      fieldName: "photo_id_back",
      originalName: "high_res_id.png",
      mimeType: "image/png",
      buffer: oversizedBuffer,
    };

    const result = await vaultService.ingestDocument(customerStellarAccount, upload);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("PAYLOAD_TOO_LARGE");
  });

  it("should reject spoofed file masquerading as PNG with SPOOFED_MAGIC_BYTES", async () => {
    const spoofedBuffer = Buffer.from("MZ\\x90\\x00\\x03ThisIsNotAPngFile", "utf-8");
    const upload: KycDocumentUpload = {
      fieldName: "photo_id_front",
      originalName: "malware.png",
      mimeType: "image/png",
      buffer: spoofedBuffer,
    };

    const result = await vaultService.ingestDocument(customerStellarAccount, upload);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SPOOFED_MAGIC_BYTES");
  });

  it("should reject disallowed MIME type with UNSUPPORTED_MEDIA_TYPE", async () => {
    const txtBuffer = Buffer.from("plain text document", "utf-8");
    const upload: KycDocumentUpload = {
      fieldName: "photo_id_front",
      originalName: "info.txt",
      mimeType: "text/plain",
      buffer: txtBuffer,
    };

    const result = await vaultService.ingestDocument(customerStellarAccount, upload);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});
