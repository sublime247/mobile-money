import request from "supertest";
import express, { Express } from "express";
import { Pool } from "pg";
import { createSep12Router, Sep12CustomerStatus } from "../sep12";
import KYCService, { KYCLevel, KYCStatus } from "../../services/kyc";
import { UserModel } from "../../models/users";
import { errorHandler } from "../../middleware/errorHandler";
import { Keypair } from "@stellar/stellar-sdk";

// Mock Stellar SDK, KYC Service & UserModel
jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    random: jest.fn().mockReturnValue({
      publicKey: () => "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7AA",
      secret: () => "SD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7AA",
    }),
    fromSecret: jest.fn(),
  },
  StrKey: {
    isValidEd25519PublicKey: jest
      .fn()
      .mockImplementation(
        (val) => typeof val === "string" && val.startsWith("G") && val.length === 56,
      ),
  },
}));
jest.mock("../../services/kyc");
jest.mock("../../models/users");

describe("SEP-12 KYC API", () => {
  let app: Express;
  let mockDb: jest.Mocked<Pool>;
  let mockKycService: jest.Mocked<KYCService>;

  beforeEach(() => {
    (UserModel as jest.MockedClass<typeof UserModel>).mockImplementation(
      () =>
        ({
          updateSensitiveData: jest.fn().mockResolvedValue(undefined),
        }) as any,
    );

    // Create mock database
    mockDb = {
      query: jest.fn(),
    } as any;

    // Create mock KYC service
    mockKycService = {
      createApplicant: jest.fn(),
      getApplicant: jest.fn(),
      uploadDocument: jest.fn(),
      submitFaceMatch: jest.fn().mockResolvedValue({
        status: "pending",
        checkId: "check-1",
        livePhotoId: "live-1",
        updatedAt: new Date().toISOString(),
      }),
      getVerificationStatus: jest.fn(),
    } as any;

    (KYCService as jest.MockedClass<typeof KYCService>).mockImplementation(
      () => mockKycService,
    );

    // Create Express app with SEP-12 router
    app = express();
    app.use(express.json());
    app.use("/sep12", createSep12Router(mockDb));
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /customer", () => {
    it("should return NEEDS_INFO for new customer", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: "",
        oid: 0,
        rowCount: 0,
        fields: [],
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123..." });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(Sep12CustomerStatus.NEEDS_INFO);
      expect(response.body.fields).toBeDefined();
      expect(response.body.fields.first_name).toBeDefined();
      expect(response.body.fields.last_name).toBeDefined();
      expect(response.body.fields.email_address).toBeDefined();
    });

    it("should return customer status for existing customer", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "user-123",
            kyc_level: KYCLevel.BASIC,
            applicant_id: "applicant-456",
            verification_status: KYCStatus.APPROVED,
          },
        ],
        command: "",
        oid: 0,
        rowCount: 1,
        fields: [],
      });

      mockKycService.getApplicant.mockResolvedValueOnce({
        id: "applicant-456",
        first_name: "John",
        last_name: "Doe",
        email: "john@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123..." });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe("user-123");
      expect(response.body.status).toBe(Sep12CustomerStatus.NEEDS_INFO);
      expect(response.body.provided_fields).toBeDefined();
      expect(response.body.provided_fields.first_name).toBeDefined();
    });

    it("should return ACCEPTED for fully verified customer", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "user-123",
            kyc_level: KYCLevel.FULL,
            applicant_id: "applicant-456",
            verification_status: KYCStatus.APPROVED,
          },
        ],
        command: "",
        oid: 0,
        rowCount: 1,
        fields: [],
      });

      mockKycService.getApplicant.mockResolvedValueOnce({
        id: "applicant-456",
        first_name: "John",
        last_name: "Doe",
        email: "john@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123..." });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(Sep12CustomerStatus.ACCEPTED);
    });

    it("should return REJECTED for rejected customer", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "user-123",
            kyc_level: KYCLevel.NONE,
            applicant_id: "applicant-456",
            verification_status: KYCStatus.REJECTED,
          },
        ],
        command: "",
        oid: 0,
        rowCount: 1,
        fields: [],
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123..." });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(Sep12CustomerStatus.REJECTED);
      expect(response.body.message).toContain("rejected");
    });

    it("should return 400 if account parameter is missing", async () => {
      const response = await request(app).get("/sep12/customer");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("account parameter is required");
    });
  });

  describe("PUT /customer", () => {
    it("should create new customer with basic information", async () => {
      // Mock user creation
      mockDb.query
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ id: "new-user-123" }],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        });

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "new-applicant-789",
        first_name: "Jane",
        last_name: "Smith",
        email: "jane@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const customerData = {
        account: "GDEF456...",
        first_name: "Jane",
        last_name: "Smith",
        email_address: "jane@example.com",
        birth_date: "1990-01-15",
        address: "123 Main St",
        city: "New York",
        postal_code: "10001",
        address_country_code: "USA",
      };

      const response = await request(app)
        .put("/sep12/customer")
        .send(customerData);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(Sep12CustomerStatus.PROCESSING);
      expect(response.body.message).toContain("being processed");
      expect(mockKycService.createApplicant).toHaveBeenCalled();
    });

    it("should update existing customer", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: "existing-user-123",
              applicant_id: "existing-applicant-456",
            },
          ],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        });

      mockKycService.getApplicant.mockResolvedValueOnce({
        id: "existing-applicant-456",
        first_name: "John",
        last_name: "Doe",
        email: "john@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const customerData = {
        account: "GABC123...",
        mobile_number: "+1234567890",
      };

      const response = await request(app)
        .put("/sep12/customer")
        .send(customerData);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(Sep12CustomerStatus.PROCESSING);
    });

    it("should handle document uploads", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ id: "new-user-123" }],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        });

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "new-applicant-789",
        first_name: "Jane",
        last_name: "Smith",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      mockKycService.uploadDocument.mockResolvedValueOnce({
        id: "doc-123",
        applicant_id: "new-applicant-789",
      });

      const customerData = {
        account: "GDEF456...",
        first_name: "Jane",
        last_name: "Smith",
        id_type: "passport",
        photo_id_front: "base64encodedimage...",
      };

      const response = await request(app)
        .put("/sep12/customer")
        .send(customerData);

      expect(response.status).toBe(200);
      expect(mockKycService.uploadDocument).toHaveBeenCalled();
      expect(mockKycService.submitFaceMatch).not.toHaveBeenCalled();
    });

    it("should send a biometric photo for face-match on registration", async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ id: "new-user-123" }],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          oid: 0,
          rowCount: 1,
          fields: [],
        });

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "new-applicant-789",
        first_name: "Jane",
        last_name: "Smith",
        created_at: new Date().toISOString(),
        sandbox: false,
      });
      mockKycService.uploadDocument.mockResolvedValueOnce({
        id: "doc-123",
        applicant_id: "new-applicant-789",
      });

      const response = await request(app)
        .put("/sep12/customer")
        .send({
          account: "GDEF456...",
          first_name: "Jane",
          last_name: "Smith",
          id_type: "passport",
          photo_id_front: "base64encodedimage...",
          biometric_photo: "base64biometric...",
        });

      expect(response.status).toBe(200);
      expect(mockKycService.submitFaceMatch).toHaveBeenCalledWith(
        expect.objectContaining({
          applicantId: "new-applicant-789",
          biometricPayload: "base64biometric...",
        }),
      );
    });

    it("should return 400 for invalid data", async () => {
      const customerData = {
        account: "GABC123...",
        email_address: "invalid-email",
      };

      const response = await request(app)
        .put("/sep12/customer")
        .send(customerData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it("should return 400 if account is missing", async () => {
      const customerData = {
        first_name: "Jane",
        last_name: "Smith",
      };

      const response = await request(app)
        .put("/sep12/customer")
        .send(customerData);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("account parameter is required");
    });
  });

  describe("DELETE /customer/:account", () => {
    const account = Keypair.random().publicKey();
    let client: { query: jest.Mock; release: jest.Mock };

    /** Route SQL issued inside the erasure transaction to canned results. */
    const mockErasureDb = (
      users: Array<{ id: string; anonymized_at: Date | null }>,
    ) => {
      client = {
        release: jest.fn(),
        query: jest.fn(async (sql: string) => {
          if (sql.includes("FROM users WHERE stellar_address")) {
            return { rows: users };
          }
          if (sql.includes("FROM transactions")) {
            return {
              rows: [
                {
                  id: "tx-1",
                  reference_number: "REF-1",
                  stellar_transaction_hash: "abc123",
                  amount: "10.0000000",
                  created_at: "2026-01-01",
                },
              ],
            };
          }
          if (sql.includes("RETURNING anonymized_at")) {
            return {
              rows: [{ anonymized_at: new Date("2026-09-24T00:00:00Z") }],
            };
          }
          return { rows: [] };
        }),
      };
      (mockDb as any).connect = jest.fn().mockResolvedValue(client);
    };

    it("anonymizes the customer and returns 200", async () => {
      mockErasureDb([{ id: "user-1", anonymized_at: null }]);

      const response = await request(app).delete(`/sep12/customer/${account}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: "anonymized",
        account,
        already_anonymized: false,
        retained_transactions: 1,
      });
      const sql = client.query.mock.calls.map(([q]) => String(q));
      expect(sql[0]).toBe("BEGIN");
      expect(sql[sql.length - 1]).toBe("COMMIT");
      expect(sql.some((q) => q.includes("UPDATE users"))).toBe(true);
      // Never a hard delete of customer or financial records.
      expect(sql.some((q) => /DELETE FROM/i.test(q))).toBe(false);
      expect(client.release).toHaveBeenCalled();
    });

    it("returns 200 without re-erasing an already anonymized customer", async () => {
      mockErasureDb([{ id: "user-1", anonymized_at: new Date("2026-01-01") }]);

      const response = await request(app).delete(`/sep12/customer/${account}`);

      expect(response.status).toBe(200);
      expect(response.body.already_anonymized).toBe(true);
      const sql = client.query.mock.calls.map(([q]) => String(q));
      expect(sql.some((q) => q.includes("UPDATE users"))).toBe(false);
    });

    it("returns 404 when the customer does not exist", async () => {
      mockErasureDb([]);

      const response = await request(app).delete(`/sep12/customer/${account}`);

      expect(response.status).toBe(404);
    });

    it("returns 400 for an invalid Stellar account", async () => {
      mockErasureDb([]);

      const response = await request(app).delete("/sep12/customer/GABC123");

      expect(response.status).toBe(400);
      expect((mockDb as any).connect).not.toHaveBeenCalled();
    });

    it("rolls back and returns 500 when anonymization fails", async () => {
      mockErasureDb([{ id: "user-1", anonymized_at: null }]);
      const base = client.query.getMockImplementation()!;
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes("UPDATE kyc_applicants")) throw new Error("db down");
        return base(sql);
      });

      const response = await request(app).delete(`/sep12/customer/${account}`);

      expect(response.status).toBe(500);
      const sql = client.query.mock.calls.map(([q]) => String(q));
      expect(sql).toContain("ROLLBACK");
      expect(sql).not.toContain("COMMIT");
    });

    it("returns 404 if account is missing", async () => {
      const response = await request(app).delete("/sep12/customer/");

      expect(response.status).toBe(404);
    });
  });

  describe("Field Requirements", () => {
    it("should return natural person fields for individual customers", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: "",
        oid: 0,
        rowCount: 0,
        fields: [],
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123..." });

      expect(response.status).toBe(200);
      expect(response.body.fields.first_name).toBeDefined();
      expect(response.body.fields.last_name).toBeDefined();
      expect(response.body.fields.birth_date).toBeDefined();
      expect(response.body.fields.address).toBeDefined();
    });

    it("should return organization fields for business customers", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: "",
        oid: 0,
        rowCount: 0,
        fields: [],
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123...", type: "organization" });

      expect(response.status).toBe(200);
      expect(response.body.fields.organization_name).toBeDefined();
      expect(
        response.body.fields.organization_registration_number,
      ).toBeDefined();
    });

    it("should include document fields for unverified customers", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "user-123",
            kyc_level: KYCLevel.NONE,
            applicant_id: null,
            verification_status: KYCStatus.PENDING,
          },
        ],
        command: "",
        oid: 0,
        rowCount: 1,
        fields: [],
      });

      const response = await request(app)
        .get("/sep12/customer")
        .query({ account: "GABC123..." });

      expect(response.status).toBe(200);
      // For PENDING status with NONE level, it returns PROCESSING
      expect(response.body.status).toBe(Sep12CustomerStatus.PROCESSING);
      expect(response.body.message).toContain("being processed");
    });
  });
});
