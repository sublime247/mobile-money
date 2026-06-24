import request from "supertest";
import express from "express";

const mockComplianceDocumentModel = {
  create: jest.fn(),
  list: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  archive: jest.fn(),
  getFacets: jest.fn(),
};

jest.mock("../../models/complianceDocument", () => ({
  ComplianceDocumentModel: jest
    .fn()
    .mockImplementation(() => mockComplianceDocumentModel),
}));

jest.mock("../../middleware/auditInterceptor", () => ({
  auditInterceptor: jest.fn(
    () =>
      (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) =>
        next(),
  ),
}));

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
  checkReplicaHealth: jest.fn(),
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    ping: jest.fn().mockResolvedValue("PONG"),
  },
}));

jest.mock("../../controllers/transactionController", () => ({
  updateAdminNotesHandler: jest.fn((_req, res) => res.json({})),
  refundTransactionHandler: jest.fn((_req, res) => res.json({})),
}));

jest.mock("../../services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({
    getAllProviderBalances: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../../queue/transactionQueue", () => ({
  getQueueStats: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../queue/dlq", () => ({
  dlqInspectorHandler: jest.fn((_req, res) => res.json({})),
}));

jest.mock("../../services/liquidityTransferService", () => ({
  triggerManualTransfer: jest.fn(),
  getLiquidityTransfers: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../middleware/rateLimit", () => ({
  rateLimitExport: (_req, _res, next) => next(),
  rateLimitListQueries: (_req, _res, next) => next(),
  RATE_LIMIT_CONFIG: {},
}));

jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({})),
  TransactionStatus: {},
}));

const { adminRoutes } = require("../admin");
const { errorHandler } = require("../../middleware/errorHandler");

const documentFixture = {
  id: "doc-123",
  title: "Ghana KYC rules",
  summary: "Local onboarding rules",
  body: "Collect national ID for regulated wallets.",
  countryCode: "GH",
  provider: "MTN",
  tags: ["kyc", "ghana"],
  sourceUrl: "https://example.com/law",
  status: "published",
  createdBy: "admin-123",
  updatedBy: "admin-123",
  createdAt: "2026-04-26T00:00:00.000Z",
  updatedAt: "2026-04-26T00:00:00.000Z",
};

const buildApp = (role = "admin") => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "admin-123", role };
    next();
  });
  app.use("/api/admin", adminRoutes);
  app.use(errorHandler);
  return app;
};

describe("Admin compliance knowledge base", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("serves the self-contained knowledge base page", async () => {
    const response = await request(buildApp()).get(
      "/api/admin/compliance/knowledge-base",
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("Compliance Knowledge Base");
  });

  it("creates a compliance document", async () => {
    mockComplianceDocumentModel.create.mockResolvedValue(documentFixture);

    const response = await request(buildApp())
      .post("/api/admin/compliance/docs")
      .send({
        title: " Ghana KYC rules ",
        body: " Collect national ID. ",
        summary: " Onboarding ",
        country: "gh",
        provider: " MTN ",
        tags: ["KYC", "ghana"],
        sourceUrl: " https://example.com/law ",
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(documentFixture);
    expect(mockComplianceDocumentModel.create).toHaveBeenCalledWith(
      {
        title: "Ghana KYC rules",
        body: "Collect national ID.",
        summary: "Onboarding",
        countryCode: "GH",
        provider: "MTN",
        tags: ["kyc", "ghana"],
        sourceUrl: "https://example.com/law",
        status: undefined,
      },
      "admin-123",
    );
  });

  it("passes list filters and pagination to the model", async () => {
    mockComplianceDocumentModel.list.mockResolvedValue({
      documents: [documentFixture],
      total: 51,
    });

    const response = await request(buildApp()).get(
      "/api/admin/compliance/docs?country=gh&provider=MTN&tag=KYC&status=published&search=wallet&page=2&limit=25",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [documentFixture],
      pagination: { total: 51, page: 2, limit: 25, totalPages: 3 },
    });
    expect(mockComplianceDocumentModel.list).toHaveBeenCalledWith({
      country: "GH",
      provider: "MTN",
      tag: "kyc",
      status: "published",
      search: "wallet",
      limit: 25,
      offset: 25,
    });
  });

  it("rejects invalid country codes", async () => {
    const response = await request(buildApp())
      .post("/api/admin/compliance/docs")
      .send({ title: "Rules", body: "Body", country: "ghana" });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("country must be a 2-letter code");
    expect(mockComplianceDocumentModel.create).not.toHaveBeenCalled();
  });

  it("normalizes comma-separated tags and removes duplicates", async () => {
    mockComplianceDocumentModel.create.mockResolvedValue(documentFixture);

    const response = await request(buildApp())
      .post("/api/admin/compliance/docs")
      .send({
        title: "Rules",
        body: "Body",
        tags: " KYC, aml, kyc,  AML ",
      });

    expect(response.status).toBe(201);
    expect(mockComplianceDocumentModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["kyc", "aml"] }),
      "admin-123",
    );
  });

  it("archives documents through the soft-delete route", async () => {
    mockComplianceDocumentModel.archive.mockResolvedValue({
      ...documentFixture,
      status: "archived",
    });

    const response = await request(buildApp()).delete(
      "/api/admin/compliance/docs/doc-123",
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("archived");
    expect(mockComplianceDocumentModel.archive).toHaveBeenCalledWith(
      "doc-123",
      "admin-123",
    );
  });

  it("forbids non-admin users", async () => {
    const response = await request(buildApp("compliance_officer"))
      .post("/api/admin/compliance/docs")
      .send({ title: "Rules", body: "Body" });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("Admin access required");
    expect(mockComplianceDocumentModel.create).not.toHaveBeenCalled();
  });
});
