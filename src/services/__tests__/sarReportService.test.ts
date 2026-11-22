import { pool } from "../../config/database";
import { UserModel } from "../../models/users";
import { TransactionModel } from "../../models/transaction";
import { AuditLogModel } from "../../models/auditLog";
import {
  SARReportService,
  maskNonPertinentFields,
} from "../sarReportService";

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../models/users");
jest.mock("../../models/transaction");
jest.mock("../../models/auditLog");

describe("Automated Suspicious Activity Report (SAR) Service (#2338)", () => {
  let sarService: SARReportService;
  let mockUserModel: any;
  let mockTransactionModel: any;
  let mockAuditLogModel: any;

  const mockUser = {
    id: "usr_suspicious_88",
    phone_number: "+237670999888",
    email: "john.doe@compliance-target.org",
    firstName: "John",
    lastName: "Doe",
    displayName: "John Doe",
    kyc_level: 2,
    password: "secret_plaintext_password",
    password_hash: "argon2id$v=19$m=65536,t=3,p=4$somehash",
    salt: "random_salt_123",
    totpSecret: "JBSWY3DPEHPK3PXP",
    status: "active",
  };

  const mockTransactions = [
    {
      id: "tx_001",
      amount: "4500000",
      currency: "XAF",
      type: "DEPOSIT",
      status: "COMPLETED",
      referenceNumber: "REF-DEP-001",
      createdAt: new Date("2026-10-15T10:00:00Z"),
    },
    {
      id: "tx_002",
      amount: "4900000",
      currency: "XAF",
      type: "TRANSFER",
      status: "COMPLETED",
      referenceNumber: "REF-TRF-002",
      createdAt: new Date("2026-10-16T11:00:00Z"),
    },
    {
      id: "tx_003",
      amount: "4800000",
      currency: "XAF",
      type: "TRANSFER",
      status: "COMPLETED",
      referenceNumber: "REF-TRF-003",
      createdAt: new Date("2026-10-17T12:00:00Z"),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockUserModel = {
      findById: jest.fn().mockResolvedValue(mockUser),
    };
    (UserModel as unknown as jest.Mock).mockImplementation(() => mockUserModel);

    mockTransactionModel = {
      findCompletedByUserSince: jest.fn().mockResolvedValue(mockTransactions),
    };
    (TransactionModel as unknown as jest.Mock).mockImplementation(
      () => mockTransactionModel,
    );

    mockAuditLogModel = {
      create: jest.fn().mockResolvedValue({ id: "audit_log_sar_001" }),
    };
    (AuditLogModel as unknown as jest.Mock).mockImplementation(
      () => mockAuditLogModel,
    );

    (pool.query as jest.Mock).mockImplementation((query: string) => {
      if (query.includes("kyc_documents")) {
        return Promise.resolve({
          rows: [
            {
              document_type: "PASSPORT",
              document_url: "https://vault.internal/docs/passport.pdf",
              verified_at: new Date("2026-01-15T00:00:00Z"),
            },
          ],
        });
      }
      if (query.includes("audit_logs")) {
        return Promise.resolve({
          rows: [
            {
              ip_address: "197.234.220.14",
              user_agent: "Mozilla/5.0 Android Mobile",
              created_at: new Date("2026-10-17T12:05:00Z"),
              metadata: { fingerprint: "fp_device_abc123" },
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    sarService = new SARReportService();
  });

  describe("maskNonPertinentFields", () => {
    it("should strip internal security fields (passwords, salts, totpSecrets)", () => {
      const masked = maskNonPertinentFields(mockUser);
      expect(masked.password).toBeUndefined();
      expect(masked.password_hash).toBeUndefined();
      expect(masked.salt).toBeUndefined();
      expect(masked.totpSecret).toBeUndefined();
    });

    it("should mask middle digits of phone numbers and email usernames", () => {
      const masked = maskNonPertinentFields(mockUser);
      expect(masked.phone_number).toBe("+237****888");
      expect(masked.email).toMatch(/^j\*+e@compliance-target\.org$/);
    });

    it("should preserve pertinent fields such as ID, name, KYC level", () => {
      const masked = maskNonPertinentFields(mockUser);
      expect(masked.id).toBe("usr_suspicious_88");
      expect(masked.displayName).toBe("John Doe");
      expect(masked.kyc_level).toBe(2);
    });
  });

  describe("generateSARDraft", () => {
    it("should collate complete transaction history into standardized FinCEN template", async () => {
      const result = await sarService.generateSARDraft(
        "usr_suspicious_88",
        "officer_aml_007",
        {
          justification: "Rapid successive high-value transfers under threshold",
        },
      );

      expect(result).toBeDefined();
      expect(result.reportId).toMatch(/^SAR-[A-F0-9]+-\d{4}$/);
      expect(result.digitalTimestamp).toBeDefined();
      expect(result.complianceOfficerId).toBe("officer_aml_007");
      expect(result.checksum).toHaveLength(64);

      // Verify FinCEN Template Structure
      const template = result.fincenTemplate;
      expect(template.header.filingType).toBe("FinCEN-SAR-v1.2");
      expect(template.subjectInformation.userId).toBe("usr_suspicious_88");
      expect(template.subjectInformation.maskedPhoneNumber).toBe("+237****888");

      // Verify KYC document collation
      expect(template.subjectInformation.kycDocuments.length).toBe(1);
      expect(template.subjectInformation.kycDocuments[0].docType).toBe("PASSPORT");

      // Verify transaction timeline compilation
      expect(template.transactionTimeline.length).toBe(3);
      expect(template.suspiciousActivitySummary.totalTransactionsEvaluated).toBe(3);
      expect(template.suspiciousActivitySummary.totalVolume).toBe(14200000);
      expect(template.suspiciousActivitySummary.narrativeJustification).toBe(
        "Rapid successive high-value transfers under threshold",
      );

      // Verify IP and device fingerprint collation
      expect(template.deviceAndIpLogs.length).toBeGreaterThan(0);
      expect(template.deviceAndIpLogs[0].ipAddress).toBe("197.234.220.14");
      expect(template.deviceAndIpLogs[0].deviceFingerprint).toBe("fp_device_abc123");
    });

    it("CRITICAL: should record compliance officer ID and generation timestamp in immutable audit log", async () => {
      await sarService.generateSARDraft(
        "usr_suspicious_88",
        "officer_aml_007",
        {
          justification: "Structuring alert trigger",
          ipAddress: "10.0.0.1",
          userAgent: "AdminPortal/2.0",
        },
      );

      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: "officer_aml_007",
          action: "SAR_GENERATED",
          resource: "compliance_sar",
          resourceId: "usr_suspicious_88",
          diff: expect.objectContaining({
            totalTransactions: 3,
            totalVolume: 14200000,
            justification: "Structuring alert trigger",
          }),
        }),
      );
    });

    it("should throw an error if the specified target user does not exist", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      await expect(
        sarService.generateSARDraft("non_existent_user", "officer_007"),
      ).rejects.toThrow(/Customer not found for SAR compilation/);
    });
  });
});
