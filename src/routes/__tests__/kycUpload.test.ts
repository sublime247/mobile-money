import request from "supertest";
import { Pool } from "pg";
import express from "express";

// Mock redis before any module imports it (prevents jest.setup.ts connection)
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

jest.mock("connect-redis", () => {
  return jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    destroy: jest.fn(),
  }));
});

import { createKYCRoutes } from "../kycRoutes";
import * as s3Upload from "../../services/s3Upload";
import KYCService from "../../services/kyc";
import { errorHandler } from "../../middleware/errorHandler";
import * as hsmService from "../../services/stellar/hsmService";

// Mock sharp before any module imports it
jest.mock("sharp", () => {
  return jest.fn().mockImplementation(() => ({
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from("optimized")),
  }));
});

// Mock AWS S3 client before any module imports it
jest.mock("@aws-sdk/client-s3", () => {
  const mockSend = jest.fn();
  const mockGetObjectCommand = jest.fn();
  const mockPutObjectCommand = jest.fn();
  const mockHeadObjectCommand = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: mockSend, destroy: jest.fn() })),
    GetObjectCommand: mockGetObjectCommand,
    PutObjectCommand: mockPutObjectCommand,
    HeadObjectCommand: mockHeadObjectCommand,
    __mockSend: mockSend,
    __mockGetObjectCommand: mockGetObjectCommand,
    __mockPutObjectCommand: mockPutObjectCommand,
    __mockHeadObjectCommand: mockHeadObjectCommand,
  };
});

// Mock KMS client (for hsmService)
jest.mock("@aws-sdk/client-kms", () => {
  const mockKmsSend = jest.fn();
  return {
    KMSClient: jest.fn(() => ({ send: mockKmsSend, destroy: jest.fn() })),
    SignCommand: jest.fn(),
    VerifyCommand: jest.fn(),
    GetPublicKeyCommand: jest.fn(),
    __mockKmsSend: mockKmsSend,
  };
});

// Mock config/s3 to avoid real AWS credentials
jest.mock("../../config/s3", () => ({
  getS3Client: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({
      Metadata: {
        "hsm-signature": "bW9ja19zaWdf",
        "hsm-key-id": "arn:aws:kms:test",
        "hsm-algorithm": "RSASSA_PSS_SHA_256",
        "hsm-digest": "bW9ja19kaWdlc3Q=",
        "hsm-signed-at": "2025-06-23T12:00:00.000Z",
      },
      Body: {
        [Symbol.asyncIterator]: () => {
          let delivered = false;
          return {
            next: () => {
              if (!delivered) {
                delivered = true;
                return Promise.resolve({ value: Buffer.from("test content"), done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      },
    }),
    destroy: jest.fn(),
  })),
  s3Config: { bucket: "test-bucket", region: "us-east-1" },
  getS3ObjectUrl: jest.fn((key) => `https://bucket.s3.amazonaws.com/${key}`),
}));

const { validateFile: realValidateFile } = jest.requireActual(
  "../../services/s3Upload",
) as typeof import("../../services/s3Upload");

const mockFileSignature = {
  signature: "bW9ja19zaWdf",
  keyId: "arn:aws:kms:us-east-1:123456789012:key/mock-key-id",
  algorithm: "RSASSA_PSS_SHA_256",
  digest: "bW9ja19kaWdlc3Q=",
  signedAt: "2025-06-23T12:00:00.000Z",
};

// Mock dependencies
jest.mock("../../services/s3Upload");
jest.mock("../../services/kyc");
jest.mock("../../middleware/auth", () => ({
  authenticateToken: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const role = req.header("x-test-role") || "user";
    req.jwtUser = { userId: "test-user-id", role } as any;
    req.user = { id: "test-user-id", email: "test@example.com", role };
    next();
  },
}));

describe("KYC Document Upload", () => {
  let app: express.Application;
  let mockPool: any;
  let mockKycService: { uploadDocumentBinary: jest.Mock };

  beforeEach(() => {
     mockKycService = {
      uploadDocumentBinary: jest.fn().mockResolvedValue({ id: "provider-doc-id" }),
    };
    (KYCService as jest.MockedClass<typeof KYCService>).mockImplementation(
      () => mockKycService as any,
    );
    // Create mock pool
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    // Mock HSM file signer — default: not configured
    (hsmService.createFileSignerFromEnv as jest.Mock).mockReturnValue(null);

    // Create express app with routes
    app = express();
    app.use(express.json());
    app.use("/api/kyc", createKYCRoutes(mockPool));
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/kyc/documents/upload", () => {
    it("should upload a valid PDF document", async () => {
      // Mock database queries
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any) // Access check
        .mockResolvedValueOnce({
          rows: [
            {
              id: "doc-id",
              file_url: "https://bucket.s3.amazonaws.com/file.pdf",
              created_at: new Date(),
            },
          ],
        } as any); // Insert document

      // Mock S3 upload
      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/file.pdf",
        key: "kyc-documents/2024/03/user-id/file.pdf",
      });

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("test pdf content"), "test.pdf")
        .field("applicant_id", "test-applicant-id")
        .field("document_type", "passport")
        .field("document_side", "front");

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.file_url).toBe("[REDACTED]");
      expect(response.body.data.document_id).toBeDefined();
      expect(response.body.data.provider_document_id).toBe("provider-doc-id");
      expect(mockKycService.uploadDocumentBinary).toHaveBeenCalledWith(
        expect.objectContaining({
          applicant_id: "test-applicant-id",
          type: "passport",
          side: "front",
          filename: "test.pdf",
          mimeType: "application/pdf",
        }),
      );
    });

    it("should return raw file_url for compliance officers", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: "doc-id",
              file_url: "https://bucket.s3.amazonaws.com/file.pdf",
              created_at: new Date(),
            },
          ],
        } as any);

      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/file.pdf",
        key: "kyc-documents/2024/03/user-id/file.pdf",
      });

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .set("x-test-role", "compliance_officer")
        .attach("document", Buffer.from("test pdf content"), "test.pdf")
        .field("applicant_id", "test-applicant-id")
        .field("document_type", "passport")
        .field("document_side", "front");

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.file_url).toBe(
        "https://bucket.s3.amazonaws.com/file.pdf",
      );
    });

    it("should successfully upload when HSM signing is configured", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: "signed-doc-id",
              file_url: "https://bucket.s3.amazonaws.com/signed.pdf",
              created_at: new Date(),
            },
          ],
        } as any);

      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/signed.pdf",
        key: "kyc-documents/2024/03/user-id/signed.pdf",
        signature: mockFileSignature,
      });

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("sensitive pii content"), "id.pdf")
        .field("applicant_id", "test-applicant-id")
        .field("document_type", "passport");

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it("should not fail upload when HSM signing errors", async () => {
      const mockSigner = {
        sign: jest.fn().mockRejectedValue(new Error("KMS temporary failure")),
        verify: jest.fn(),
        verifyWithDigestCheck: jest.fn(),
        dispose: jest.fn(),
      };
      (hsmService.createFileSignerFromEnv as jest.Mock).mockReturnValue(mockSigner);

      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: "graceful-doc-id",
              file_url: "https://bucket.s3.amazonaws.com/graceful.pdf",
              created_at: new Date(),
            },
          ],
        } as any);

      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/graceful.pdf",
        key: "kyc-documents/2024/03/user-id/graceful.pdf",
      });

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("content"), "doc.pdf")
        .field("applicant_id", "test-applicant-id");

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it("should reject upload without file", async () => {
      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .field("applicant_id", "test-applicant-id");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("No file uploaded");
    });

    it("should reject invalid file type", async () => {
      (s3Upload.validateFile as jest.Mock).mockReturnValue({
        valid: false,
        error: "Invalid file type",
      });

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("test content"), "test.txt")
        .field("applicant_id", "test-applicant-id");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Invalid file type");
    });

    it("should reject upload without applicant_id", async () => {
      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("test pdf content"), "test.pdf");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("applicant_id is required");
    });

    it("should reject upload for non-owned applicant", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("test pdf content"), "test.pdf")
        .field("applicant_id", "other-applicant-id");

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Access denied");
    });

    it("should handle S3 upload failure", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] } as any);

      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: false,
        error: "S3 upload failed",
      });

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("test pdf content"), "test.pdf")
        .field("applicant_id", "test-applicant-id");

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("File upload failed");
      expect(mockKycService.uploadDocumentBinary).not.toHaveBeenCalled();
    });

    it("should surface provider submission failures after storing the upload", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: "doc-id",
              file_url: "https://bucket.s3.amazonaws.com/file.pdf",
              created_at: new Date(),
            },
          ],
        } as any);

      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/file.pdf",
        key: "kyc-documents/2024/03/user-id/file.pdf",
      });
      mockKycService.uploadDocumentBinary.mockRejectedValueOnce(
        new Error("Entrust request failed after a transient network error: socket hang up"),
      );

      const response = await request(app)
        .post("/api/kyc/documents/upload")
        .attach("document", Buffer.from("test pdf content"), "test.pdf")
        .field("applicant_id", "test-applicant-id")
        .field("document_type", "passport");

      expect(response.status).toBe(500);
      expect(response.body.message).toContain("transient network error");
    });
  });

  describe("GET /api/kyc/documents", () => {
    it("should mask file_url for non-compliance users", async () => {
      const mockDocuments = [
        {
          id: "doc-1",
          applicant_id: "app-1",
          document_type: "passport",
          document_side: "front",
          file_url: "https://bucket.s3.amazonaws.com/file1.pdf",
          s3_key: "kyc-documents/2024/03/user-id/file1.pdf",
          original_filename: "passport.pdf",
          file_size: 1024,
          mime_type: "application/pdf",
          created_at: new Date(),
        },
      ];

      mockPool.query.mockResolvedValueOnce({ rows: mockDocuments } as any);

      const response = await request(app).get("/api/kyc/documents");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe("doc-1");
      expect(response.body.data[0].file_url).toBe("[REDACTED]");
    });

    it("should return raw file_url for compliance officers", async () => {
      const mockDocuments = [
        {
          id: "doc-1",
          applicant_id: "app-1",
          document_type: "passport",
          document_side: "front",
          file_url: "https://bucket.s3.amazonaws.com/file1.pdf",
          s3_key: "kyc-documents/2024/03/user-id/file1.pdf",
          original_filename: "passport.pdf",
          file_size: 1024,
          mime_type: "application/pdf",
          created_at: new Date(),
        },
      ];

      mockPool.query.mockResolvedValueOnce({ rows: mockDocuments } as any);

      const response = await request(app)
        .get("/api/kyc/documents")
        .set("x-test-role", "compliance_officer");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].file_url).toBe(
        "https://bucket.s3.amazonaws.com/file1.pdf",
      );
    });

    it("should return empty array when no documents", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const response = await request(app).get("/api/kyc/documents");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(0);
    });

    it("should include hsm_signed field for signed documents", async () => {
      const mockDocuments = [
        {
          id: "doc-1",
          applicant_id: "app-1",
          document_type: "passport",
          document_side: "front",
          file_url: "https://bucket.s3.amazonaws.com/file1.pdf",
          s3_key: "kyc-documents/2024/03/user-id/file1.pdf",
          original_filename: "passport.pdf",
          file_size: 1024,
          mime_type: "application/pdf",
          created_at: new Date(),
        },
      ];

      mockPool.query.mockResolvedValueOnce({ rows: mockDocuments } as any);

      const response = await request(app).get("/api/kyc/documents");

      expect(response.status).toBe(200);
      expect(response.body.data[0]).toHaveProperty("hsm_signed");
    });
  });

  describe("GET /api/kyc/documents/:id/verify", () => {
    it("should return 404 for non-existent document", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const response = await request(app).get("/api/kyc/documents/bad-id/verify");

      expect(response.status).toBe(404);
    });

    it("should indicate no signature when HSM not configured", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            s3_key: "kyc-documents/2024/03/user-id/doc.pdf",
            original_filename: "doc.pdf",
            file_size: 100,
          },
        ],
      } as any);

      (hsmService.createFileSignerFromEnv as jest.Mock).mockReturnValue(null);

      const response = await request(app).get("/api/kyc/documents/doc-1/verify");

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        verified: false,
      });
    });
  });
});

describe("File Validation", () => {
  it("should validate PDF files", () => {
    const file = {
      mimetype: "application/pdf",
      size: 1024 * 1024, // 1MB
    } as Express.Multer.File;

    const result = realValidateFile(file);
    expect(result.valid).toBe(true);
  });

  it("should validate JPEG files", () => {
    const file = {
      mimetype: "image/jpeg",
      size: 1024 * 1024,
    } as Express.Multer.File;

    const result = realValidateFile(file);
    expect(result.valid).toBe(true);
  });

  it("should validate PNG files", () => {
    const file = {
      mimetype: "image/png",
      size: 1024 * 1024,
    } as Express.Multer.File;

    const result = realValidateFile(file);
    expect(result.valid).toBe(true);
  });

  it("should reject invalid file types", () => {
    const file = {
      originalname: "notes.txt",
      mimetype: "text/plain",
      size: 1024,
    } as Express.Multer.File;

    const result = realValidateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid file type");
  });

  it("should reject files exceeding size limit", () => {
    const file = {
      originalname: "large.pdf",
      mimetype: "application/pdf",
      size: 6 * 1024 * 1024, // 6MB
    } as Express.Multer.File;

    const result = realValidateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds maximum limit");
  });
});
