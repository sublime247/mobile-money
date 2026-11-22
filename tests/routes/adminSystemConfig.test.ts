import request from "supertest";
import express from "express";

jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../src/config/redis", () => ({
  __esModule: true,
  connectRedis: jest.fn().mockResolvedValue(undefined),
  disconnectRedis: jest.fn().mockResolvedValue(undefined),
  redisClient: {
    isOpen: false,
    on: jest.fn(),
    connect: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn(),
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
  },
  createRedisStore: jest.fn(),
  SESSION_TTL_SECONDS: 86400,
}));

jest.mock("../../src/services/layeredCache", () => ({
  layeredCache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    delPattern: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../src/middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { id: "admin-1", role: "admin" };
    next();
  },
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: "admin-1", role: "admin" };
    next();
  },
}));

jest.mock("../../src/middleware/auditInterceptor", () => ({
  auditInterceptor: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/middleware/rateLimit", () => ({
  rateLimitExport: (_req: any, _res: any, next: any) => next(),
  rateLimitListQueries: (_req: any, _res: any, next: any) => next(),
  RATE_LIMIT_CONFIG: {},
}));

jest.mock("../../src/middleware/errorHandler", () => ({
  createError: (code: string, message: string) => {
    const err: any = new Error(message);
    err.statusCode = 400;
    err.code = code;
    return err;
  },
}));

jest.mock("../../src/constants/errorCodes", () => ({
  ERROR_CODES: {
    INTERNAL_ERROR: "INTERNAL_ERROR",
    INVALID_INPUT: "INVALID_INPUT",
    NOT_FOUND: "NOT_FOUND",
    UNAUTHORIZED: "UNAUTHORIZED",
    FORBIDDEN: "FORBIDDEN",
    LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  },
}));

const mockQuery = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: mockQuery },
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
  getTelecomAverageMetrics: jest.fn().mockReturnValue([]),
}));

jest.mock("../../src/utils/circuitBreaker", () => ({
  getAllCircuitBreakerStatesInfo: jest.fn().mockReturnValue([]),
  tripCircuitBreaker: jest.fn(),
  forceCloseCircuitBreaker: jest.fn(),
  resetCircuitBreakerForProvider: jest.fn(),
}));

jest.mock("../../src/services/providerSettingsService", () => ({
  providerSettingsService: {
    getAllSettings: jest.fn().mockResolvedValue([]),
    getProviderSettings: jest.fn().mockResolvedValue(null),
    setProviderEnabled: jest.fn(),
    resolveMaintenanceRouting: jest.fn().mockResolvedValue({ action: "proceed" }),
  },
}));

jest.mock("../../src/services/cacheAside", () => ({
  ProviderConfigCacheInvalidation: { invalidate: jest.fn() },
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  getQueueStats: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/queue/dlq", () => ({
  dlqInspectorHandler: (_req: any, res: any) => res.json({ success: true }),
}));

jest.mock("../../src/services/liquidityTransferService", () => ({
  triggerManualTransfer: jest.fn(),
  getLiquidityTransfers: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../src/services/metrics", () => ({
  getTransactionResolutionPercentiles: jest.fn().mockResolvedValue([]),
  getDisputeResolutionPercentiles: jest.fn().mockResolvedValue([]),
  getTransactionResolutionTrends: jest.fn().mockResolvedValue([]),
  getDisputeResolutionTrends: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../src/services/csvReconciliation", () => ({
  parseCSV: jest.fn(),
  reconcileTransactions: jest.fn(),
}));

jest.mock("../../src/services/providerReconciliationService", () => ({
  ProviderReconciliationService: jest.fn().mockImplementation(() => ({
    getReconciliationHistory: jest.fn().mockResolvedValue([]),
    getPendingAlerts: jest.fn().mockResolvedValue([]),
    reviewAlert: jest.fn(),
  })),
}));

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn(),
}));

jest.mock("../../src/services/stellar/highThroughputService", () => ({
  __esModule: true,
  default: { someMethod: jest.fn() },
}));

jest.mock("../../src/services/ledgerService", () => ({
  ledgerService: { someMethod: jest.fn() },
}));

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({
    initiatePayment: jest.fn(),
    sendPayout: jest.fn(),
    getAllProviderBalances: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../../src/models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn(),
    updateStatus: jest.fn(),
    getAuditHistory: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn(),
    findByStatuses: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    updateAdminNotes: jest.fn(),
    updateStatus: jest.fn(),
  })),
  TransactionStatus: {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
  },
}));

jest.mock("../../src/models/complianceDocument", () => ({
  ComplianceDocumentModel: jest.fn().mockImplementation(() => ({})),
  ComplianceDocumentStatus: {},
  ComplianceDocumentCreateInput: {},
  ComplianceDocumentUpdateInput: {},
}));

jest.mock("../../src/controllers/transactionController", () => ({
  updateAdminNotesHandler: (_req: any, res: any) =>
    res.json({ success: true }),
  refundTransactionHandler: (_req: any, res: any) =>
    res.json({ success: true }),
}));

jest.mock("../../src/auth/jwt", () => ({
  generateToken: jest.fn().mockReturnValue("mock-token"),
}));

jest.mock("multer", () => {
  const multerMock: any = () => ({
    single: () => (_req: any, _res: any, next: any) => next(),
  });
  multerMock.memoryStorage = () => ({});
  return multerMock;
});

const mockSystemConfigService = {
  getAll: jest.fn(),
  get: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  bulkUpsert: jest.fn(),
  getValueAs: jest.fn(),
};

jest.mock("../../src/services/systemConfigService", () => ({
  systemConfigService: mockSystemConfigService,
}));

import { adminRoutes as adminRouter } from "../../src/routes/admin";

let app: express.Express;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: "admin-1", role: "admin" } });
    next();
  });
  app.use("/api/admin", adminRouter);

  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({
      error: err.message,
      code: err.code,
    });
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Admin System Configuration Panel", () => {
  describe("GET /api/admin/config", () => {
    it("should list all system configs", async () => {
      const mockConfigs = [
        {
          key: "rate_limit_max_requests",
          value: "100",
          category: "rate_limiting",
          description: "Max requests per minute",
          value_type: "number",
          updated_by: "admin-1",
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          key: "feature_flag_new_dashboard",
          value: "true",
          category: "features",
          description: "Enable new dashboard UI",
          value_type: "boolean",
          updated_by: "admin-1",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      mockSystemConfigService.getAll.mockResolvedValue(mockConfigs);

      const res = await request(app).get("/api/admin/config");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.configs).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should list configs filtered by category", async () => {
      const mockConfigs = [
        {
          key: "rate_limit_max_requests",
          value: "100",
          category: "rate_limiting",
          description: "Max requests per minute",
          value_type: "number",
          updated_by: "admin-1",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      mockSystemConfigService.getAll.mockResolvedValue(mockConfigs);

      const res = await request(app)
        .get("/api/admin/config")
        .query({ category: "rate_limiting" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSystemConfigService.getAll).toHaveBeenCalledWith("rate_limiting");
    });

    it("should return empty list when no configs exist", async () => {
      mockSystemConfigService.getAll.mockResolvedValue([]);

      const res = await request(app).get("/api/admin/config");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.configs).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });
  });

  describe("GET /api/admin/config/:key", () => {
    it("should return a specific config entry", async () => {
      const mockConfig = {
        key: "rate_limit_max_requests",
        value: "100",
        category: "rate_limiting",
        description: "Max requests per minute",
        value_type: "number",
        updated_by: "admin-1",
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockSystemConfigService.get.mockResolvedValue(mockConfig);

      const res = await request(app).get("/api/admin/config/rate_limit_max_requests");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.key).toBe("rate_limit_max_requests");
    });

    it("should return 404 for non-existent config key", async () => {
      mockSystemConfigService.get.mockResolvedValue(null);

      const res = await request(app).get("/api/admin/config/nonexistent_key");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("PUT /api/admin/config", () => {
    it("should create or update a config entry", async () => {
      const mockConfig = {
        key: "deposit_min_amount",
        value: "100",
        category: "limits",
        description: "Minimum deposit amount",
        value_type: "number",
        updated_by: "admin-1",
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockSystemConfigService.upsert.mockResolvedValue(mockConfig);

      const res = await request(app)
        .put("/api/admin/config")
        .send({
          key: "deposit_min_amount",
          value: "100",
          category: "limits",
          description: "Minimum deposit amount",
          value_type: "number",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.key).toBe("deposit_min_amount");
      expect(mockSystemConfigService.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "deposit_min_amount",
          value: "100",
        }),
      );
    });

    it("should reject config without key", async () => {
      const res = await request(app)
        .put("/api/admin/config")
        .send({ value: "100" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("key is required");
    });

    it("should reject config without value", async () => {
      const res = await request(app)
        .put("/api/admin/config")
        .send({ key: "some_key" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("value is required");
    });

    it("should reject invalid value_type", async () => {
      const res = await request(app)
        .put("/api/admin/config")
        .send({
          key: "some_key",
          value: "100",
          value_type: "invalid",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("value_type");
    });
  });

  describe("DELETE /api/admin/config/:key", () => {
    it("should delete a config entry", async () => {
      mockSystemConfigService.delete.mockResolvedValue(true);

      const res = await request(app).delete("/api/admin/config/old_setting");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("deleted");
    });

    it("should return 404 for non-existent config key", async () => {
      mockSystemConfigService.delete.mockResolvedValue(false);

      const res = await request(app).delete("/api/admin/config/nonexistent");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("PATCH /api/admin/config/bulk", () => {
    it("should bulk upsert multiple configs", async () => {
      const mockConfigs = [
        {
          key: "setting_a",
          value: "100",
          category: "general",
          value_type: "number",
          updated_by: "admin-1",
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          key: "setting_b",
          value: "enabled",
          category: "general",
          value_type: "string",
          updated_by: "admin-1",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      mockSystemConfigService.bulkUpsert.mockResolvedValue(mockConfigs);

      const res = await request(app)
        .patch("/api/admin/config/bulk")
        .send({
          configs: [
            { key: "setting_a", value: "100", value_type: "number" },
            { key: "setting_b", value: "enabled", value_type: "string" },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.configs).toHaveLength(2);
    });

    it("should reject empty configs array", async () => {
      const res = await request(app)
        .patch("/api/admin/config/bulk")
        .send({ configs: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("non-empty array");
    });

    it("should reject configs exceeding 50 limit", async () => {
      const configs = Array.from({ length: 51 }, (_, i) => ({
        key: `key_${i}`,
        value: `${i}`,
      }));

      const res = await request(app)
        .patch("/api/admin/config/bulk")
        .send({ configs });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("50");
    });

    it("should reject config without key in bulk", async () => {
      const res = await request(app)
        .patch("/api/admin/config/bulk")
        .send({
          configs: [{ value: "100" }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("key");
    });
  });
});
