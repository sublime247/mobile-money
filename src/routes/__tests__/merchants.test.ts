import request from "supertest";
import express from "express";

// Create the mock service object at module level
const mockMerchantService = {
  createMerchant: jest.fn(),
  bulkCreateMerchants: jest.fn(),
  getBatchJobStatus: jest.fn(),
  listMerchants: jest.fn(),
  getMerchant: jest.fn(),
  acceptInvitation: jest.fn(),
};

// Mock MerchantService to return mockMerchantService
jest.mock("../../services/merchantService", () => ({
  MerchantService: jest.fn().mockImplementation(() => mockMerchantService),
}));

// Mock authenticateToken middleware to set user and proceed
jest.mock("../../middleware/auth", () => ({
  authenticateToken: jest.fn((req, res, next) => {
    req.user = { id: "admin-123", role: "admin" };
    next();
  }),
}));

import { merchantRoutes } from "../merchants";
import { CreateMerchantInput } from "../../models/merchant";

describe("Merchant Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Reset mock implementations and calls
    mockMerchantService.createMerchant.mockReset();
    mockMerchantService.bulkCreateMerchants.mockReset();
    mockMerchantService.getBatchJobStatus.mockReset();
    mockMerchantService.listMerchants.mockReset();
    mockMerchantService.getMerchant.mockReset();
    mockMerchantService.acceptInvitation.mockReset();
    
    app.use("/api/merchants", merchantRoutes);
  });

  describe("POST /api/merchants", () => {
    it("should return 400 if required fields are missing", async () => {
      const response = await request(app)
        .post("/api/merchants")
        .send({ name: "Test Merchant" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing required fields");
    });

    it("should create merchant and return 201", async () => {
      const input: CreateMerchantInput = {
        name: "Test Merchant",
        email: "test@example.com",
        phoneNumber: "+237670000000",
      };

      const mockMerchant = {
        id: "merchant-123",
        ...input,
        status: "pending",
        createdAt: new Date(),
      };

      mockMerchantService.createMerchant.mockResolvedValue(mockMerchant as any);

      const response = await request(app)
        .post("/api/merchants")
        .send(input);

      expect(response.status).toBe(201);
      expect(response.body.message).toBe("Merchant invitation sent successfully");
      expect(response.body.merchant.id).toBe(mockMerchant.id);
    });

    it("should return 400 if merchant creation fails", async () => {
      mockMerchantService.createMerchant.mockRejectedValue(new Error("Email already exists"));

      const response = await request(app)
        .post("/api/merchants")
        .send({
          name: "Test Merchant",
          email: "existing@example.com",
          phoneNumber: "+237670000000",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Failed to create merchant");
    });
  });

  describe("POST /api/merchants/bulk", () => {
    it("should return 400 if no file is uploaded", async () => {
      const response = await request(app)
        .post("/api/merchants/bulk")
        .attach("file", "");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("No file uploaded");
    });

    it("should return 400 if CSV file is empty", async () => {
      const emptyCsv = Buffer.from("name,email,phone_number\n");

      const response = await request(app)
        .post("/api/merchants/bulk")
        .attach("file", emptyCsv, { filename: "merchants.csv", contentType: "text/csv" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("CSV file contains no data rows");
    });

    it("should return 422 if CSV validation fails", async () => {
      const invalidCsv = Buffer.from("name,email,phone_number\n,invalid-email,123");

      const response = await request(app)
        .post("/api/merchants/bulk")
        .attach("file", invalidCsv, { filename: "merchants.csv", contentType: "text/csv" });

      expect(response.status).toBe(422);
      expect(response.body.error).toBe("CSV validation failed");
      expect(response.body.validationErrors).toHaveLength(3); // name, email, phone
    });

    it("should accept valid CSV and return 202", async () => {
      const validCsv = Buffer.from(
        "name,email,phone_number,business_name\nJohn Doe,john@example.com,+237670000000,John's Store"
      );

      mockMerchantService.bulkCreateMerchants.mockResolvedValue({
        jobId: "job-123",
        total: 1,
        message: "Bulk merchant import queued - 1 merchant(s) will be processed",
        statusUrl: "/api/merchants/bulk/job-123",
      });

      const response = await request(app)
        .post("/api/merchants/bulk")
        .attach("file", validCsv, { filename: "merchants.csv", contentType: "text/csv" });

      expect(response.status).toBe(202);
      expect(response.body.jobId).toBe("job-123");
      expect(response.body.total).toBe(1);
    });
  });

  describe("GET /api/merchants/bulk/:jobId", () => {
    it("should return 404 if job not found", async () => {
      mockMerchantService.getBatchJobStatus.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/merchants/bulk/non-existent-job");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Job not found");
    });

    it("should return job status", async () => {
      const jobStatus = {
        jobId: "job-123",
        status: "completed",
        progress: {
          total: 10,
          processed: 10,
          succeeded: 8,
          failed: 2,
        },
        errors: [
          { row: 5, error: "Duplicate email" },
          { row: 8, error: "Invalid phone number" },
        ],
        createdAt: new Date(),
        completedAt: new Date(),
      };

      mockMerchantService.getBatchJobStatus.mockResolvedValue(jobStatus as any);

      const response = await request(app)
        .get("/api/merchants/bulk/job-123");

      expect(response.status).toBe(200);
      expect(response.body.jobId).toBe("job-123");
      expect(response.body.status).toBe("completed");
      expect(response.body.progress.succeeded).toBe(8);
    });
  });

  describe("GET /api/merchants", () => {
    it("should return list of merchants", async () => {
      mockMerchantService.listMerchants.mockResolvedValue({
        merchants: [
          { id: "1", name: "Merchant 1", email: "m1@example.com" },
          { id: "2", name: "Merchant 2", email: "m2@example.com" },
        ],
        total: 2,
        pagination: {
          page: 1,
          limit: 50,
          totalPages: 1,
        },
      });

      const response = await request(app)
        .get("/api/merchants");

      expect(response.status).toBe(200);
      expect(response.body.merchants).toHaveLength(2);
      expect(response.body.total).toBe(2);
    });
  });

  describe("GET /api/merchants/:id", () => {
    it("should return 404 if merchant not found", async () => {
      mockMerchantService.getMerchant.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/merchants/non-existent-id");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Merchant not found");
    });

    it("should return merchant details", async () => {
      const merchant = {
        id: "merchant-123",
        name: "Test Merchant",
        email: "test@example.com",
        phoneNumber: "+237670000000",
        status: "pending",
      };

      mockMerchantService.getMerchant.mockResolvedValue(merchant as any);

      const response = await request(app)
        .get("/api/merchants/merchant-123");

      expect(response.status).toBe(200);
      expect(response.body.id).toBe("merchant-123");
      expect(response.body.name).toBe("Test Merchant");
    });
  });

  describe("POST /api/merchants/invite/:token/accept", () => {
    it("should return 404 if invitation token is invalid", async () => {
      mockMerchantService.acceptInvitation.mockResolvedValue(null);

      const response = await request(app)
        .post("/api/merchants/invite/invalid-token/accept");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Invalid or expired invitation token");
    });

    it("should accept invitation and return merchant", async () => {
      const merchant = {
        id: "merchant-123",
        name: "Test Merchant",
        email: "test@example.com",
        status: "active",
      };

      mockMerchantService.acceptInvitation.mockResolvedValue(merchant as any);

      const response = await request(app)
        .post("/api/merchants/invite/valid-token/accept");

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Invitation accepted successfully");
      expect(response.body.merchant.status).toBe("active");
    });
  });
});

describe("CSV Validation", () => {
  describe("validateRow", () => {
    // Import the validateRow function for testing
    // This would need to be exported from the routes file
    it("should validate correct CSV row", () => {
      // Test implementation would go here
      // For now, we test through the API
    });

    it("should detect missing name", () => {
      // Test through API
    });

    it("should detect invalid email", () => {
      // Test through API
    });

    it("should detect invalid phone number", () => {
      // Test through API
    });

    it("should detect invalid country code", () => {
      // Test through API
    });
  });
});