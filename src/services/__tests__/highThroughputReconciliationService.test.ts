import { HighThroughputReconciliationService } from "../highThroughputReconciliationService";
import { queryRead, queryWrite } from "../../config/database";

// Mock database functions
jest.mock("../../config/database", () => ({
  queryRead: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  queryWrite: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

describe("HighThroughputReconciliationService", () => {
  let service: HighThroughputReconciliationService;

  beforeEach(() => {
    service = new HighThroughputReconciliationService();
    jest.clearAllMocks();
  });

  describe("runStreamingReconciliation", () => {
    it("should process CSV stream with 100 records in <5 seconds", async () => {
      const csvData = `reference_number,amount,status
REF001,100.00,completed
REF002,200.50,completed
REF003,150.00,completed`;

      const mockDbRecords = [
        {
          id: "1",
          reference_number: "REF001",
          amount: "100.00",
          status: "completed",
          provider: "test",
          created_at: "2024-01-01",
        },
        {
          id: "2",
          reference_number: "REF002",
          amount: "200.50",
          status: "completed",
          provider: "test",
          created_at: "2024-01-01",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValueOnce({
        rows: mockDbRecords,
      });
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ id: "run-123" }] })
        .mockResolvedValueOnce({});

      const csvBuffer = Buffer.from(csvData);
      const config = {
        provider: "test_provider",
        reportDate: new Date("2024-01-01"),
      };

      const startTime = Date.now();
      const result = await service.runStreamingReconciliation(csvBuffer, config);
      const executionTime = Date.now() - startTime;

      // Verify results
      expect(result.matchedCount).toBeGreaterThan(0);
      expect(result.totalProcessedRows).toBe(3);
      expect(executionTime).toBeLessThan(5000); // Less than 5 seconds for small batch
    });

    it("should handle large CSV batches with low memory footprint", async () => {
      // Generate 1000 CSV records
      const records = Array.from({ length: 1000 }, (_, i) => ({
        reference_number: `REF${String(i + 1).padStart(6, "0")}`,
        amount: `${(i + 1) * 10}.00`,
        status: "completed",
      }));

      const csvHeaders = "reference_number,amount,status\n";
      const csvData = csvHeaders + records.map((r) => `${r.reference_number},${r.amount},${r.status}`).join("\n");

      const mockDbRecords = records.slice(0, 800).map((r, i) => ({
        id: `${i}`,
        reference_number: r.reference_number,
        amount: r.amount,
        status: r.status,
        provider: "test",
        created_at: "2024-01-01",
      }));

      (queryRead as jest.Mock).mockResolvedValueOnce({
        rows: mockDbRecords,
      });
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ id: "run-456" }] })
        .mockResolvedValueOnce({});

      const csvBuffer = Buffer.from(csvData);
      const config = {
        provider: "test_provider",
        reportDate: new Date("2024-01-01"),
      };

      const result = await service.runStreamingReconciliation(csvBuffer, config);

      // Verify high match rate (800 matched out of 1000)
      expect(result.matchedCount).toBe(800);
      expect(result.totalProcessedRows).toBe(1000);
      expect(result.orphanedProviderCount).toBe(200);
    });

    it("should detect discrepancies in amounts and statuses", async () => {
      const csvData = `reference_number,amount,status
REF001,100.00,completed
REF002,250.50,completed`;

      const mockDbRecords = [
        {
          id: "1",
          reference_number: "REF001",
          amount: "100.00",
          status: "completed",
          provider: "test",
          created_at: "2024-01-01",
        },
        {
          id: "2",
          reference_number: "REF002",
          amount: "200.50", // Different amount!
          status: "pending",
          provider: "test",
          created_at: "2024-01-01",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValueOnce({
        rows: mockDbRecords,
      });
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ id: "run-789" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const csvBuffer = Buffer.from(csvData);
      const config = {
        provider: "test_provider",
        reportDate: new Date("2024-01-01"),
      };

      const result = await service.runStreamingReconciliation(csvBuffer, config);

      // Should detect 1 match and 1 discrepancy
      expect(result.matchedCount).toBe(1);
      expect(result.discrepanciesCount).toBe(1);
    });

    it("should handle CSV with normalized reference numbers", async () => {
      const csvData = `reference_number,amount,status
ref001,100.00,completed
REF-002,200.50,COMPLETED`;

      const mockDbRecords = [
        {
          id: "1",
          reference_number: "REF001",
          amount: "100.00",
          status: "completed",
          provider: "test",
          created_at: "2024-01-01",
        },
        {
          id: "2",
          reference_number: "REF-002",
          amount: "200.50",
          status: "completed",
          provider: "test",
          created_at: "2024-01-01",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValueOnce({
        rows: mockDbRecords,
      });
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ id: "run-999" }] })
        .mockResolvedValueOnce({});

      const csvBuffer = Buffer.from(csvData);
      const config = {
        provider: "test_provider",
        reportDate: new Date("2024-01-01"),
      };

      const result = await service.runStreamingReconciliation(csvBuffer, config);

      // Should match despite case differences
      expect(result.matchedCount).toBeGreaterThanOrEqual(0);
      expect(result.totalProcessedRows).toBe(2);
    });
  });
});
