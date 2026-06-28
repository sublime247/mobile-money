const mockList = jest.fn();
const mockCount = jest.fn();
const mockFindByStatuses = jest.fn();
const mockCountByStatuses = jest.fn();

// Mock the TransactionModel first to ensure it's mocked when controllers are imported
jest.mock("../src/models/transaction", () => {
  const actual = jest.requireActual("../src/models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => {
      return {
        list: mockList,
        count: mockCount,
        findByStatuses: mockFindByStatuses,
        countByStatuses: mockCountByStatuses,
      };
    }),
  };
});
jest.mock("../src/middleware/timeout", () => ({
  TimeoutPresets: {
    quick: (req: any, res: any, next: any) => next(),
    long: (req: any, res: any, next: any) => next(),
  },
  haltOnTimedout: (req: any, res: any, next: any) => next(),
}));

import request from "supertest";
import express, { Express } from "express";
import { Router } from "express";
import {
  validateTransactionFilters,
  TransactionStatus,
  VALID_STATUSES,
  parseStatusFilter,
  buildStatusWhereClause,
  getPaginationInfo,
} from "../src/utils/transactionFilters";
import { listTransactionsHandler } from "../src/controllers/transactionController";
import { TransactionModel } from "../src/models/transaction";
import { TimeoutPresets, haltOnTimedout } from "../src/middleware/timeout";
import { errorHandler } from "../src/middleware/errorHandler";

describe("Transaction Status Filtering - Utility Functions", () => {
  describe("parseStatusFilter", () => {
    it("should parse single status filter", () => {
      const result = parseStatusFilter("pending");
      expect(result).toEqual(["pending"]);
    });

    it("should parse multiple comma-separated statuses", () => {
      const result = parseStatusFilter("pending,completed,failed");
      expect(result).toEqual(["pending", "completed", "failed"]);
    });

    it("should trim whitespace from statuses", () => {
      const result = parseStatusFilter("pending , completed , failed");
      expect(result).toEqual(["pending", "completed", "failed"]);
    });

    it("should return empty array for empty string", () => {
      const result = parseStatusFilter("");
      expect(result).toEqual([]);
    });

    it("should filter out empty values", () => {
      expect(parseStatusFilter("pending,,completed")).toEqual(["pending", "completed"]);
    });

    it("should handle only hyphens", () => {
      expect(parseStatusFilter("---")).toEqual([]);
    });

    it("should validate each status is valid enum value", () => {
      expect(() => parseStatusFilter("invalid")).toThrow();
    });

    it("should validate mixed valid and invalid statuses", () => {
      expect(() => parseStatusFilter("pending,invalid")).toThrow();
    });

    it("should reject statuses with special characters", () => {
      expect(() => parseStatusFilter("pending<script>")).toThrow();
    });
  });

  describe("buildStatusWhereClause", () => {
    it("should return empty clause for empty status array", () => {
      const result = buildStatusWhereClause([]);
      expect(result).toBe("");
    });

    it("should build IN clause for single status", () => {
      const result = buildStatusWhereClause([TransactionStatus.Pending]);
      expect(result).toBe("status IN ('pending')");
    });

    it("should build IN clause for multiple statuses", () => {
      const result = buildStatusWhereClause([
        TransactionStatus.Pending,
        TransactionStatus.Completed,
      ]);
      expect(result).toBe("status IN ('pending', 'completed')");
    });

    it("should properly escape status values", () => {
      const result = buildStatusWhereClause([TransactionStatus.Failed]);
      expect(result).toBe("status IN ('failed')");
    });

    it("should produce valid SQL syntax", () => {
      const result = buildStatusWhereClause([
        TransactionStatus.Pending,
        TransactionStatus.Cancelled,
      ]);
      expect(result).toMatch(/^status IN \([^)]+\)$/);
    });
  });

  describe("getPaginationInfo", () => {
    it("should calculate pagination for first page", () => {
      const result = getPaginationInfo(100, 50, 0);
      expect(result).toEqual({
        total: 100,
        limit: 50,
        offset: 0,
        hasMore: true,
        totalPages: 2,
        currentPage: 1,
      });
    });

    it("should calculate pagination for last page", () => {
      const result = getPaginationInfo(100, 50, 50);
      expect(result).toEqual({
        total: 100,
        limit: 50,
        offset: 50,
        hasMore: false,
        totalPages: 2,
        currentPage: 2,
      });
    });

    it("should handle single page", () => {
      const result = getPaginationInfo(30, 50, 0);
      expect(result).toEqual({
        total: 30,
        limit: 50,
        offset: 0,
        hasMore: false,
        totalPages: 1,
        currentPage: 1,
      });
    });

    it("should handle empty result", () => {
      const result = getPaginationInfo(0, 50, 0);
      expect(result).toEqual({
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
        totalPages: 0,
        currentPage: 1,
      });
    });

    it("should handle exact multiple pages", () => {
      const result = getPaginationInfo(150, 50, 100);
      expect(result).toEqual({
        total: 150,
        limit: 50,
        offset: 100,
        hasMore: false,
        totalPages: 3,
        currentPage: 3,
      });
    });
  });
});

describe("Transaction Status Filtering - Middleware", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  describe("validateTransactionFilters middleware", () => {
    it("should accept valid status filter", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters).toBeDefined();
        expect(filters.statuses).toEqual(["pending"]);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should accept multiple statuses", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.statuses).toEqual(["pending", "completed"]);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending,completed")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should reject invalid status", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?status=invalid")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("Invalid status");
        })
        .end(done);
    });

    it("should accept valid startDate and endDate parameters with timezone offsets", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.startDate).toBe("2026-06-28T14:33:52Z");
        expect(filters.endDate).toBe("2026-06-28T15:32:52+01:00");
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?startDate=2026-06-28T14:33:52Z&endDate=2026-06-28T15:32:52%2B01:00")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should reject invalid startDate format (missing timezone)", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?startDate=2026-06-28T14:33:52")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("Invalid startDate parameter");
        })
        .end(done);
    });

    it("should reject invalid endDate format (missing timezone)", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?endDate=2026-06-28T15:32:52")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("Invalid endDate parameter");
        })
        .end(done);
    });

    it("should reject invalid date strings", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?startDate=invalid-date-format")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("Invalid startDate parameter");
        })
        .end(done);
    });

    it("should set default limit to 50", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.limit).toBe(50);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should accept custom limit", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.limit).toBe(100);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending&limit=100")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should allow higher limits up to 1000", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.limit).toBe(500);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending&limit=500")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should reject non-numeric limit", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?status=pending&limit=abc")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("limit");
        })
        .end(done);
    });

    it("should reject negative limit", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?status=pending&limit=-10")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("limit");
        })
        .end(done);
    });

    it("should accept offset parameter", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.offset).toBe(50);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending&offset=50")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should default offset to 0", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        const filters = (req as any).transactionFilters;
        expect(filters.offset).toBe(0);
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=pending")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("should reject negative offset", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?status=pending&offset=-5")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("offset");
        })
        .end(done);
    });
  });
});

describe("Transaction Status Filtering - Handler Integration", () => {
  let app: Express;
  const controllerTransactionModel = {
    list: mockList,
    count: mockCount,
    findByStatuses: mockFindByStatuses,
    countByStatuses: mockCountByStatuses,
  } as unknown as jest.Mocked<TransactionModel>;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    jest.clearAllMocks();
    controllerTransactionModel.findByStatuses.mockReset();
    controllerTransactionModel.countByStatuses.mockReset();
    controllerTransactionModel.list.mockReset();
    controllerTransactionModel.count.mockReset();

    controllerTransactionModel.list.mockImplementation(() => {
      return controllerTransactionModel.findByStatuses();
    });
    controllerTransactionModel.count.mockImplementation(() => {
      return controllerTransactionModel.countByStatuses();
    });
  });

  describe("listTransactionsHandler", () => {
    it("should return transactions with pagination", async () => {
      const mockTransactions = [
        {
          id: "1",
          status: "pending",
          amount: "100",
          createdAt: new Date(),
        },
        {
          id: "2",
          status: "pending",
          amount: "200",
          createdAt: new Date(),
        },
      ];

      controllerTransactionModel.findByStatuses.mockResolvedValue(
        mockTransactions as any,
      );
      controllerTransactionModel.countByStatuses.mockResolvedValue(2);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);

      const res = await request(app).get("/?status=pending").expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.total).toBe(2);
      expect(res.body.pagination.limit).toBe(50);
      expect(res.body.pagination.hasMore).toBe(false);
    });

    it("should handle empty results", async () => {
      controllerTransactionModel.findByStatuses.mockResolvedValue([]);
      controllerTransactionModel.countByStatuses.mockResolvedValue(0);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);

      const res = await request(app).get("/?status=pending").expect(200);

      expect(res.body.data).toHaveLength(0);
      expect(res.body.pagination.total).toBe(0);
    });

    it("should handle multiple status filters", async () => {
      const mockTransactions = [
        { id: "1", status: "pending", amount: "100" },
        { id: "2", status: "completed", amount: "200" },
      ];

      controllerTransactionModel.findByStatuses.mockResolvedValue(
        mockTransactions as any,
      );
      controllerTransactionModel.countByStatuses.mockResolvedValue(2);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);

      const res = await request(app)
        .get("/?status=pending,completed")
        .expect(200);

      expect(res.body.data).toHaveLength(2);
    });

    it("should return pagination metadata", async () => {
      const mockTransactions = Array(50)
        .fill(null)
        .map((_, i) => ({ id: `${i}`, status: "pending" }));

      controllerTransactionModel.findByStatuses.mockResolvedValue(
        mockTransactions as any,
      );
      controllerTransactionModel.countByStatuses.mockResolvedValue(150);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);

      const res = await request(app)
        .get("/?status=pending&limit=50&offset=0")
        .expect(200);

      expect(res.body.pagination).toEqual({
        total: 150,
        limit: 50,
        offset: 0,
        hasMore: true,
        totalPages: 3,
        currentPage: 1,
      });
    });

    it("should include filters in response", async () => {
      controllerTransactionModel.findByStatuses.mockResolvedValue([]);
      controllerTransactionModel.countByStatuses.mockResolvedValue(0);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);

      const res = await request(app)
        .get("/?status=pending,completed")
        .expect(200);

      expect(res.body.filters.statuses).toEqual(["pending", "completed"]);
    });

    it("should handle database errors gracefully", async () => {
      controllerTransactionModel.findByStatuses.mockRejectedValue(
        new Error("Database error"),
      );
      controllerTransactionModel.countByStatuses.mockResolvedValue(1);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);
      app.use(errorHandler);

      const res = await request(app).get("/?status=pending").expect(500);

      expect(res.body.error).toContain("Failed to list transactions");
    });

    it("should validate all statuses before querying", async () => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      const res = await request(app).get("/?status=invalid").expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should handle pagination correctly on page 2", async () => {
      const mockTransactions = Array(50)
        .fill(null)
        .map((_, i) => ({ id: `${50 + i}`, status: "pending" }));

      controllerTransactionModel.findByStatuses.mockResolvedValue(
        mockTransactions as any,
      );
      controllerTransactionModel.countByStatuses.mockResolvedValue(150);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);

      const res = await request(app)
        .get("/?status=pending&limit=50&offset=50")
        .expect(200);

      expect(res.body.pagination.currentPage).toBe(2);
      expect(res.body.pagination.hasMore).toBe(true);
    });

    it("should work without status filter (list all)", async () => {
      const mockTransactions = [
        { id: "1", status: "pending" },
        { id: "2", status: "completed" },
        { id: "3", status: "failed" },
      ];

      controllerTransactionModel.findByStatuses.mockResolvedValue(
        mockTransactions as any,
      );
      controllerTransactionModel.countByStatuses.mockResolvedValue(3);

      const router = Router();
      router.get("/", validateTransactionFilters, listTransactionsHandler);
      app.use(router);
      app.use(errorHandler);

      const res = await request(app).get("/").expect(200);

      expect(res.body.data).toHaveLength(3);
      expect(res.body.filters.statuses).toEqual(VALID_STATUSES);
    });
  });
});
