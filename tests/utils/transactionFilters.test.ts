import { Request, Response, NextFunction } from "express";
import {
  TransactionStatus,
  parseStatusFilter,
  buildStatusWhereClause,
  validateTransactionFilters,
  getPaginationInfo,
} from "../../src/utils/transactionFilters";

describe("transactionFilters", () => {
  describe("parseStatusFilter", () => {
    it("should return empty array for undefined or empty string", () => {
      expect(parseStatusFilter(undefined)).toEqual([]);
      expect(parseStatusFilter("")).toEqual([]);
    });

    it("should parse a single valid status", () => {
      expect(parseStatusFilter("pending")).toEqual([TransactionStatus.Pending]);
    });

    it("should parse multiple valid statuses", () => {
      expect(parseStatusFilter("pending,completed")).toEqual([
        TransactionStatus.Pending,
        TransactionStatus.Completed,
      ]);
    });

    it("should throw an error for invalid statuses", () => {
      expect(() => parseStatusFilter("pending,unknown")).toThrow(/Invalid status values: unknown/);
    });
  });

  describe("buildStatusWhereClause", () => {
    it("should return empty string for empty array", () => {
      expect(buildStatusWhereClause([])).toBe("");
    });

    it("should return empty string if all statuses are selected", () => {
      const allStatuses = Object.values(TransactionStatus) as TransactionStatus[];
      expect(buildStatusWhereClause(allStatuses)).toBe("");
    });

    it("should build IN clause for specific statuses", () => {
      expect(buildStatusWhereClause([TransactionStatus.Pending])).toBe("status IN ('pending')");
      expect(buildStatusWhereClause([TransactionStatus.Pending, TransactionStatus.Completed])).toBe(
        "status IN ('pending', 'completed')"
      );
    });
  });

  describe("validateTransactionFilters middleware", () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: NextFunction;

    beforeEach(() => {
      mockReq = { query: {} };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      mockNext = jest.fn();
    });

    it("should apply default values", () => {
      validateTransactionFilters(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).transactionFilters).toEqual({
        statuses: [],
        limit: 50,
        offset: 0,
        reference: undefined,
      });
    });

    it("should parse provided valid values", () => {
      mockReq.query = { status: "pending,failed", limit: "20", offset: "10", reference: "ref123" };
      validateTransactionFilters(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).transactionFilters).toEqual({
        statuses: [TransactionStatus.Pending, TransactionStatus.Failed],
        limit: 20,
        offset: 10,
        reference: "ref123",
      });
    });

    it("should cap limit at 1000", () => {
      mockReq.query = { limit: "2000" };
      validateTransactionFilters(mockReq as Request, mockRes as Response, mockNext);

      expect((mockReq as any).transactionFilters.limit).toBe(1000);
    });

    it("should return 400 for invalid limit", () => {
      mockReq.query = { limit: "-5" };
      validateTransactionFilters(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid limit parameter" }));
    });

    it("should return 400 for invalid offset", () => {
      mockReq.query = { offset: "-5" };
      validateTransactionFilters(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid offset parameter" }));
    });

    it("should return 400 for invalid status", () => {
      mockReq.query = { status: "invalid" };
      validateTransactionFilters(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid status parameter" }));
    });
  });

  describe("getPaginationInfo", () => {
    it("should calculate correct pagination info", () => {
      const info = getPaginationInfo(100, 20, 0);
      expect(info).toEqual({
        total: 100,
        limit: 20,
        offset: 0,
        hasMore: true,
        totalPages: 5,
        currentPage: 1,
      });
    });

    it("should handle offset correctly", () => {
      const info = getPaginationInfo(100, 20, 80);
      expect(info.hasMore).toBe(false);
      expect(info.currentPage).toBe(5);
    });
  });
});
