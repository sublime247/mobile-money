import request from "supertest";
import express from "express";
import { adminRoutes } from "../admin";
import * as csvReconciliation from "../../services/csvReconciliation";

jest.mock("../../services/csvReconciliation");
jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    ping: jest.fn().mockResolvedValue("PONG"),
  },
}));

describe("Admin CSV Reconciliation Endpoint", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock auth middleware to set admin user
    app.use((req, _res, next) => {
      (req as any).user = { id: "admin-123", role: "admin" };
      next();
    });

    app.use("/api/admin", adminRoutes);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/admin/reconcile", () => {
    it("should successfully reconcile CSV file", async () => {
      const mockResult = {
        total_provider_rows: 2,
        total_db_records: 2,
        matched: [
          {
            reference_number: "TXN-20260327-00001",
            amount: "100.50",
            status: "completed",
            matched: true,
          },
        ],
        discrepancies: [],
        orphaned_provider: [],
        orphaned_db: [],
        summary: {
          match_rate: "100.00%",
          total_matched: 1,
          total_discrepancies: 0,
          total_orphaned_provider: 0,
          total_orphaned_db: 0,
        },
      };

      (csvReconciliation.parseCSV as jest.Mock).mockResolvedValue([
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
      ]);

      (csvReconciliation.reconcileTransactions as jest.Mock).mockResolvedValue(
        mockResult,
      );

      const csvContent = `reference_number,amount,status
TXN-20260327-00001,100.50,completed`;

      const response = await request(app)
        .post("/api/admin/reconcile")
        .attach("csv", Buffer.from(csvContent), "transactions.csv");

      expect(response.status).toBe(200);
      expect(response.body.message).toBe(
        "Reconciliation completed successfully",
      );
      expect(response.body.result).toEqual(mockResult);
      expect(csvReconciliation.parseCSV).toHaveBeenCalled();
      expect(csvReconciliation.reconcileTransactions).toHaveBeenCalled();
    });

    it("should return 400 if no file is uploaded", async () => {
      const response = await request(app).post("/api/admin/reconcile");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("No file uploaded");
    });

    it("should return 400 if CSV is empty", async () => {
      (csvReconciliation.parseCSV as jest.Mock).mockResolvedValue([]);

      const csvContent = `reference_number,amount,status`;

      const response = await request(app)
        .post("/api/admin/reconcile")
        .attach("csv", Buffer.from(csvContent), "empty.csv");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Empty CSV");
    });

    it("should handle date range parameters", async () => {
      const mockResult = {
        total_provider_rows: 1,
        total_db_records: 1,
        matched: [],
        discrepancies: [],
        orphaned_provider: [],
        orphaned_db: [],
        summary: {
          match_rate: "0.00%",
          total_matched: 0,
          total_discrepancies: 0,
          total_orphaned_provider: 0,
          total_orphaned_db: 0,
        },
      };

      (csvReconciliation.parseCSV as jest.Mock).mockResolvedValue([
        { reference_number: "TXN-20260327-00001" },
      ]);

      (csvReconciliation.reconcileTransactions as jest.Mock).mockResolvedValue(
        mockResult,
      );

      const csvContent = `reference_number,amount,status
TXN-20260327-00001,100.50,completed`;

      const response = await request(app)
        .post("/api/admin/reconcile")
        .query({ start_date: "2026-03-27", end_date: "2026-03-28" })
        .attach("csv", Buffer.from(csvContent), "transactions.csv");

      expect(response.status).toBe(200);
      expect(csvReconciliation.reconcileTransactions).toHaveBeenCalledWith(
        expect.any(Array),
        { start: "2026-03-27", end: "2026-03-28" },
      );
    });

    it("should handle reconciliation errors", async () => {
      (csvReconciliation.parseCSV as jest.Mock).mockRejectedValue(
        new Error("Invalid CSV format"),
      );

      const csvContent = `invalid,csv,content`;

      const response = await request(app)
        .post("/api/admin/reconcile")
        .attach("csv", Buffer.from(csvContent), "invalid.csv");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Reconciliation failed");
      expect(response.body.message).toBe("Invalid CSV format");
    });

    it("should reject non-CSV files", async () => {
      const response = await request(app)
        .post("/api/admin/reconcile")
        .attach("csv", Buffer.from("not a csv"), "file.txt")
        .set("Content-Type", "text/plain");

      expect(response.status).toBe(500);
    });
  });
});
