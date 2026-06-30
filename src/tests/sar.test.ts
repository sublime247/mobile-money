import { generateSAR } from "../compliance/sar";
import { amlService } from "../services/aml";
import { TransactionModel } from "../models/transaction";
import * as userService from "../services/userService";
import * as s3Upload from "../services/s3Upload";
import crypto from "crypto";
import { DB_ENCRYPTION_KEY } from "../config/env";

jest.mock("../services/aml");
jest.mock("../models/transaction");
jest.mock("../services/userService");
jest.mock("../services/s3Upload");

describe("SAR Generation", () => {
  const mockUserId = "user-123";
  const mockUser = {
    id: mockUserId,
    phone_number: "237670000000",
    kyc_level: "verified",
  };

  const mockTransactions = [
    {
      id: "tx-1",
      amount: "500000",
      type: "deposit",
      status: "completed",
      createdAt: new Date(),
      referenceNumber: "REF12345678",
    },
  ];

  const mockAlerts = [
    {
      id: "alert-1",
      userId: mockUserId,
      ruleHits: [{ rule: "single_transaction_threshold" }],
      createdAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    (userService.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (
      TransactionModel.prototype.findCompletedByUserSince as jest.Mock
    ).mockResolvedValue(mockTransactions);
    (amlService.getAlerts as jest.Mock).mockReturnValue(mockAlerts);
    (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
      success: true,
      fileUrl: "https://s3.amazonaws.com/bucket/sar-123.pdf.enc",
    });
  });

  it("should generate, encrypt, and store both PDF and XML reports", async () => {
    const result = await generateSAR(mockUserId);

    expect(result).toHaveProperty("pdfUrl");
    expect(result).toHaveProperty("xmlUrl");
    expect(userService.getUserById).toHaveBeenCalledWith(mockUserId);

    // Expect 2 calls to uploadToS3 (one for PDF, one for XML)
    expect(s3Upload.uploadToS3).toHaveBeenCalledTimes(2);

    const pdfUpload = (s3Upload.uploadToS3 as jest.Mock).mock.calls.find((c) =>
      c[0].file.originalname.endsWith(".pdf.enc"),
    );
    const xmlUpload = (s3Upload.uploadToS3 as jest.Mock).mock.calls.find((c) =>
      c[0].file.originalname.endsWith(".xml.enc"),
    );

    expect(pdfUpload).toBeDefined();
    expect(xmlUpload).toBeDefined();

    // Verify PDF encryption
    const pdfBuffer = pdfUpload[0].file.buffer;
    const decryptedPdf = decryptBuffer(pdfBuffer);
    expect(decryptedPdf.toString("utf8", 0, 4)).toBe("%PDF");

    // Verify XML encryption
    const xmlBuffer = xmlUpload[0].file.buffer;
    const decryptedXml = decryptBuffer(xmlBuffer);
    expect(decryptedXml.toString("utf8")).toContain('<?xml version="1.0"');
    expect(decryptedXml.toString("utf8")).toContain(
      "<SuspiciousActivityReport>",
    );
  });

  it("should throw error if user not found", async () => {
    (userService.getUserById as jest.Mock).mockResolvedValue(null);
    await expect(generateSAR("unknown")).rejects.toThrow("User not found");
  });

  it("should throw error if storage fails", async () => {
    (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
      success: false,
      error: "S3 down",
    });
    await expect(generateSAR(mockUserId)).rejects.toThrow(
      "Failed to store SAR",
    );
  });
});

/** Helper to decrypt buffers in test */
function decryptBuffer(encryptedBuffer: Buffer): Buffer {
  const IV_LENGTH = 12;
  const AUTH_TAG_LENGTH = 16;
  const iv = encryptedBuffer.slice(0, IV_LENGTH);
  const authTag = encryptedBuffer.slice(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encryptedData = encryptedBuffer.slice(IV_LENGTH + AUTH_TAG_LENGTH);

  const secretKey = crypto.scryptSync(
    DB_ENCRYPTION_KEY || "test-key",
    "sar-salt",
    32,
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}
