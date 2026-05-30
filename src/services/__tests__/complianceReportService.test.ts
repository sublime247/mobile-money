import { generateFlaggedTransactionComplianceReport } from "../complianceReportService";
import * as s3Upload from "../s3Upload";
import { AMLAlert } from "../aml";
import { Transaction } from "../../models/transaction";
import crypto from "crypto";
import { DB_ENCRYPTION_KEY } from "../../config/env";

jest.mock("../s3Upload");

describe("Compliance Report Service", () => {
  const mockTransaction: Transaction = {
    id: "tx-123",
    referenceNumber: "REF-123",
    type: "deposit",
    amount: "1500000",
    phoneNumber: "+237670000000",
    provider: "mtn",
    status: "pending",
    userId: "user-123",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: new Date("2026-01-01T12:00:00.000Z"),
  } as Transaction;

  const mockAlert: AMLAlert = {
    id: "alert-123",
    transactionId: "tx-123",
    userId: "user-123",
    severity: "high",
    status: "pending_review",
    ruleHits: [
      {
        rule: "single_transaction_threshold",
        message: "Transaction exceeded single transfer threshold",
        observed: 1500000,
        threshold: 1000000,
      },
    ],
    reasons: ["amount above threshold"],
    createdAt: new Date("2026-01-01T12:05:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-01T12:05:00.000Z").toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
      success: true,
      fileUrl: "https://s3.amazonaws.com/bucket/compliance-tx-123.pdf.enc",
    });
  });

  it("generates, encrypts, and stores a compliance PDF for flagged transactions", async () => {
    const result = await generateFlaggedTransactionComplianceReport(
      mockTransaction,
      mockAlert,
    );

    expect(result.pdfUrl).toBe(
      "https://s3.amazonaws.com/bucket/compliance-tx-123.pdf.enc",
    );
    expect(s3Upload.uploadToS3).toHaveBeenCalledTimes(1);

    const uploadCall = (s3Upload.uploadToS3 as jest.Mock).mock.calls[0][0];
    expect(uploadCall.file.originalname).toMatch(/COMPLIANCE_TX_tx-123_alert-123_\d+\.pdf\.enc$/);
    expect(uploadCall.file.mimetype).toBe("application/octet-stream");

    const encryptedBuffer: Buffer = uploadCall.file.buffer;
    expect(encryptedBuffer.length).toBeGreaterThan(0);

    const decryptedPdf = decryptBuffer(encryptedBuffer);
    expect(decryptedPdf.toString("utf8", 0, 4)).toBe("%PDF");
    expect(decryptedPdf.toString("utf8")).toContain("Flagged Transaction Compliance Report");
    expect(decryptedPdf.toString("utf8")).toContain("Alert ID: alert-123");
  });

  it("throws when storage fails", async () => {
    (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
      success: false,
      error: "S3 upload error",
    });

    await expect(
      generateFlaggedTransactionComplianceReport(mockTransaction, mockAlert),
    ).rejects.toThrow("Failed to store compliance report PDF");
  });
});

function decryptBuffer(encryptedBuffer: Buffer): Buffer {
  const iv = encryptedBuffer.slice(0, 12);
  const authTag = encryptedBuffer.slice(12, 12 + 16);
  const encryptedData = encryptedBuffer.slice(12 + 16);
  const secretKey = crypto.scryptSync(DB_ENCRYPTION_KEY, "compliance-report-salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}
