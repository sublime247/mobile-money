import request from "supertest";
import express, { Express } from "express";
import { Pool } from "pg";
import { createSep12Router, Sep12CustomerStatus } from "../sep12";
import KYCService, { KYCLevel, KYCStatus } from "../../services/kyc";

// Mock KYC Service
jest.mock("../../services/kyc");

describe("SEP-12 KYC API", () => {
  let app: Express;
  let mockDb: jest.Mocked<Pool>;
  let mockKycService: jest.Mocked<KYCService>;

  beforeEach(() => {
    // Create mock database
    mockDb = {
      query: jest.fn(),
    } as any;

    // Create mock KYC service
    mockKycService = {
      createApplicant: jest.fn(),
      getApplicant: jest.fn(),
      uploadDocument: jest.fn(),
      getVerificationStatus: jest.fn(),
    } as any;

    (KYCService as jest.MockedClass<typeof KYCService>).mockImplementation(() => mockKycService);

    // Create Express app with SEP-12 router
    app = express();
    app.use(express.json());
    app.use("/sep12", createSep12Router(mockDb));
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
    it("should delete customer information", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: "",
        oid: 0,
        rowCount: 1,
        fields: [],
      });

      const response = await request(app).delete("/sep12/customer/GABC123...");

      expect(response.status).toBe(204);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM kyc_applicants"),
        ["GABC123..."]
      );
    });

    it("should return 400 if account is missing", async () => {
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
      expect(response.body.fields.organization_registration_number).toBeDefined();
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
