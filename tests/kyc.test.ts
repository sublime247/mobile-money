import { Pool } from "pg";
import KYCService, { KYCStatus, KYCLevel, DocumentType } from "../src/services/kyc";

jest.mock("../src/services/accounting", () => ({
  AccountingService: jest.fn().mockImplementation(() => ({
    syncContactForUser: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockPool = {
  query: jest.fn(),
} as unknown as jest.Mocked<Pool>;

describe("KYCService", () => {
  let kycService: KYCService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KYC_API_KEY = "test_api_key";
    process.env.KYC_API_URL = "https://api.test.onfido.com/v3.6";
    kycService = new KYCService(mockPool);
  });

  it("returns configured limits for none/unverified level", () => {
    const limits = kycService.getTransactionLimits(KYCLevel.NONE);
    expect(limits.perTransactionLimit.min).toBeGreaterThan(0);
    expect(limits.perTransactionLimit.max).toBeGreaterThanOrEqual(
      limits.perTransactionLimit.min,
    );
  });

  it("retries transient status fetches and returns approved basic verification", async () => {
    const getMock = jest
      .spyOn((kycService as any).api, "get")
      .mockImplementationOnce(async () => {
        throw new Error("socket hang up");
      })
      .mockResolvedValueOnce({
        data: {
          checks: [{ id: "check-1", applicant_id: "applicant-1", status: "complete" }],
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          reports: [
            {
              id: "report-1",
              name: "document",
              status: "approved",
              result: "clear",
            },
          ],
        },
      } as any);

    const result = await kycService.getVerificationStatus("applicant-1");

    expect(getMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(KYCStatus.APPROVED);
    expect(result.level).toBe(KYCLevel.BASIC);
    expect(result.rejectionReason).toBeNull();
  });

  it("flags fraudulent documents for manual review", async () => {
    jest
      .spyOn((kycService as any).api, "get")
      .mockResolvedValueOnce({ data: { checks: [{ id: "check-1", applicant_id: "applicant-1" }] } } as any)
      .mockResolvedValueOnce({
        data: {
          reports: [
            {
              id: "report-1",
              name: "document",
              status: "complete",
              result: "suspected fraud",
              breakdown: [{ name: "forgery", result: "fraudulent document" }],
            },
          ],
        },
      } as any);

    const result = await kycService.getVerificationStatus("applicant-1");

    expect(result.status).toBe(KYCStatus.REVIEW);
    expect(result.level).toBe(KYCLevel.NONE);
    expect(result.rejectionReason).toBe("Fraudulent Document");
  });

  it("uploads binary images to Entrust with multipart form data", async () => {
    const postMock = jest.spyOn((kycService as any).api, "post").mockResolvedValueOnce({
      data: { id: "provider-doc-1" },
    } as any);

    const response = await kycService.uploadDocumentBinary({
      applicant_id: "applicant-1",
      type: DocumentType.PASSPORT,
      side: "front",
      filename: "passport.png",
      mimeType: "image/png",
      fileBuffer: Buffer.from("image-bytes"),
    });

    expect(response.id).toBe("provider-doc-1");
    expect(postMock).toHaveBeenCalledWith(
      "/documents",
      expect.any(FormData),
      expect.objectContaining({ timeout: 45000 }),
    );
  });

  it("persists approved webhook results and upgrades the user tier", async () => {
    const getMock = jest
      .spyOn((kycService as any).api, "get")
      .mockResolvedValueOnce({
        data: { applicant_id: "applicant-1", applicant: { id: "applicant-1" } },
      } as any)
      .mockResolvedValueOnce({
        data: { checks: [{ id: "check-1", applicant_id: "applicant-1" }] },
      } as any)
      .mockResolvedValueOnce({
        data: {
          reports: [
            { id: "report-1", name: "document", status: "approved", result: "clear" },
            {
              id: "report-2",
              name: "facial_similarity",
              status: "approved",
              result: "clear",
            },
          ],
        },
      } as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ user_id: "user-1", kyc_level: "full" }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    await kycService.handleWebhook({
      payload: {
        action: "workflow_run.completed",
        object: { id: "workflow-run-1", type: "workflow_run" },
        webhook_id: "webhook-1",
      },
    });

    expect(getMock).toHaveBeenCalledWith("/workflow_runs/workflow-run-1");
    expect(mockPool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE kyc_applicants"),
      expect.arrayContaining([KYCStatus.APPROVED, KYCLevel.FULL, null, "applicant-1"]),
    );
    expect(mockPool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users"),
      ["full", "user-1"],
    );
  });
});

describe("Database Schema", () => {
  it("documents the current kyc_applicants defaults", () => {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS kyc_applicants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        applicant_id VARCHAR(255) UNIQUE NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'entrust',
        applicant_data JSONB,
        verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        kyc_level VARCHAR(20) NOT NULL DEFAULT 'none',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;

    expect(createTableSQL).toContain("kyc_applicants");
    expect(createTableSQL).toContain("verification_status VARCHAR(20) NOT NULL DEFAULT 'pending'");
    expect(createTableSQL).toContain("kyc_level VARCHAR(20) NOT NULL DEFAULT 'none'");
  });
});
