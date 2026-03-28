import {
  parseCSV,
  reconcileTransactions,
  ProviderCSVRow,
} from "../csvReconciliation";
import { queryRead } from "../../config/database";

jest.mock("../../config/database");

describe("CSV Reconciliation Service", () => {
  describe("parseCSV", () => {
    it("should parse valid CSV buffer", async () => {
      const csvContent = `reference_number,amount,status,phone_number
TXN-20260327-00001,100.50,completed,+1234567890
TXN-20260327-00002,250.00,pending,+0987654321`;

      const buffer = Buffer.from(csvContent);
      const result = await parseCSV(buffer);

      expect(result).toHaveLength(2);
      expect(result[0].reference_number).toBe("TXN-20260327-00001");
      expect(result[0].amount).toBe("100.50");
      expect(result[1].reference_number).toBe("TXN-20260327-00002");
    });

    it("should handle empty CSV", async () => {
      const csvContent = `reference_number,amount,status`;
      const buffer = Buffer.from(csvContent);
      const result = await parseCSV(buffer);

      expect(result).toHaveLength(0);
    });
  });

  describe("reconcileTransactions", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should match transactions correctly", async () => {
      const providerRows: ProviderCSVRow[] = [
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
        {
          reference_number: "TXN-20260327-00002",
          amount: "250.00",
          status: "pending",
        },
      ];

      const dbRecords = [
        {
          id: "uuid-1",
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
          phone_number: "+1234567890",
          provider: "orange",
          created_at: "2026-03-27T10:00:00Z",
        },
        {
          id: "uuid-2",
          reference_number: "TXN-20260327-00002",
          amount: "250.00",
          status: "pending",
          phone_number: "+0987654321",
          provider: "mtn",
          created_at: "2026-03-27T11:00:00Z",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({ rows: dbRecords });

      const result = await reconcileTransactions(providerRows);

      expect(result.total_provider_rows).toBe(2);
      expect(result.total_db_records).toBe(2);
      expect(result.matched).toHaveLength(2);
      expect(result.discrepancies).toHaveLength(0);
      expect(result.orphaned_provider).toHaveLength(0);
      expect(result.orphaned_db).toHaveLength(0);
      expect(result.summary.match_rate).toBe("100.00%");
    });

    it("should detect amount discrepancies", async () => {
      const providerRows: ProviderCSVRow[] = [
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
      ];

      const dbRecords = [
        {
          id: "uuid-1",
          reference_number: "TXN-20260327-00001",
          amount: "150.50", // Different amount
          status: "completed",
          phone_number: "+1234567890",
          provider: "orange",
          created_at: "2026-03-27T10:00:00Z",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({ rows: dbRecords });

      const result = await reconcileTransactions(providerRows);

      expect(result.matched).toHaveLength(0);
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].matched).toBe(false);
      expect(result.summary.total_discrepancies).toBe(1);
    });

    it("should detect status discrepancies", async () => {
      const providerRows: ProviderCSVRow[] = [
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
      ];

      const dbRecords = [
        {
          id: "uuid-1",
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "pending", // Different status
          phone_number: "+1234567890",
          provider: "orange",
          created_at: "2026-03-27T10:00:00Z",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({ rows: dbRecords });

      const result = await reconcileTransactions(providerRows);

      expect(result.matched).toHaveLength(0);
      expect(result.discrepancies).toHaveLength(1);
      expect(result.summary.total_discrepancies).toBe(1);
    });

    it("should identify orphaned provider records", async () => {
      const providerRows: ProviderCSVRow[] = [
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
        {
          reference_number: "TXN-20260327-99999",
          amount: "500.00",
          status: "completed",
        },
      ];

      const dbRecords = [
        {
          id: "uuid-1",
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
          phone_number: "+1234567890",
          provider: "orange",
          created_at: "2026-03-27T10:00:00Z",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({ rows: dbRecords });

      const result = await reconcileTransactions(providerRows);

      expect(result.matched).toHaveLength(1);
      expect(result.orphaned_provider).toHaveLength(1);
      expect(result.orphaned_provider[0].reference_number).toBe(
        "TXN-20260327-99999",
      );
      expect(result.summary.total_orphaned_provider).toBe(1);
    });

    it("should identify orphaned database records", async () => {
      const providerRows: ProviderCSVRow[] = [
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
      ];

      const dbRecords = [
        {
          id: "uuid-1",
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
          phone_number: "+1234567890",
          provider: "orange",
          created_at: "2026-03-27T10:00:00Z",
        },
        {
          id: "uuid-2",
          reference_number: "TXN-20260327-00002",
          amount: "250.00",
          status: "pending",
          phone_number: "+0987654321",
          provider: "mtn",
          created_at: "2026-03-27T11:00:00Z",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({ rows: dbRecords });

      const result = await reconcileTransactions(providerRows);

      expect(result.matched).toHaveLength(1);
      expect(result.orphaned_db).toHaveLength(1);
      expect(result.orphaned_db[0].reference_number).toBe(
        "TXN-20260327-00002",
      );
      expect(result.summary.total_orphaned_db).toBe(1);
    });

    it("should handle date range filtering", async () => {
      const providerRows: ProviderCSVRow[] = [
        {
          reference_number: "TXN-20260327-00001",
          amount: "100.50",
          status: "completed",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await reconcileTransactions(providerRows, {
        start: "2026-03-27",
        end: "2026-03-28",
      });

      expect(queryRead).toHaveBeenCalledWith(
        expect.stringContaining("created_at >= $1"),
        expect.arrayContaining(["2026-03-27", "2026-03-28"]),
      );
    });
  });
});
