import {
  parseMpesaStatement,
  MpesaReconciliationService,
  normalizeAmount,
} from "../mpesaReconciliation";
import { queryRead } from "../../../config/database";
import { ReconciliationModel, ReconciliationStatus, DiscrepancyType } from "../../../models/reconciliation";

jest.mock("../../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../../models/reconciliation", () => {
  const original = jest.requireActual("../../../models/reconciliation");
  return {
    ...original,
    ReconciliationModel: jest.fn().mockImplementation(() => ({
      createReport: jest.fn().mockResolvedValue({ id: "mock-report-123" }),
      createDiscrepancy: jest.fn().mockResolvedValue({ id: "mock-disc-1" }),
      updateReport: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

describe("M-Pesa B2C Reconciliation", () => {
  const sampleCsv = `Receipt No.,Completion Time,Details,Transaction Status,Withdrawn,Balance,ConversationID,Recipient
QK12345678,2026-10-16 10:15:00,B2C Payment to Customer,Completed,1500.00,85000.00,CONV-1001,254712345678
QK12345679,2026-10-16 11:20:00,B2C Payment to Customer,Completed,2000.00,83000.00,CONV-1002,254712345679
QK12345680,2026-10-16 12:45:00,B2C Payment to Customer,Completed,500.00,82500.00,CONV-1003,254712345680
QK12345681,2026-10-16 14:00:00,B2C Payment to Customer,Completed,750.00,81750.00,CONV-1004,254712345681
QK12345682,2026-10-16 14:05:00,B2C Payment to Customer,Completed,750.00,81000.00,CONV-1004,254712345681
`;

  describe("parseMpesaStatement", () => {
    it("parses valid M-Pesa CSV rows into typed records", async () => {
      const records = await parseMpesaStatement(sampleCsv);
      expect(records.length).toBe(5);

      expect(records[0]).toEqual({
        receiptNo: "QK12345678",
        completionTime: "2026-10-16 10:15:00",
        details: "B2C Payment to Customer",
        status: "Completed",
        amount: "1500.00",
        balance: "85000.00",
        conversationId: "CONV-1001",
        originatorConversationId: undefined,
        recipientPhone: "254712345678",
      });
    });

    it("normalizes amounts with currency symbols and spaces", () => {
      expect(normalizeAmount("KES 1,500.50")).toBe("1500.50");
      expect(normalizeAmount("-2,000")).toBe("2000.00");
      expect(normalizeAmount("")).toBe("0.00");
    });
  });

  describe("MpesaReconciliationService.reconcile", () => {
    let service: MpesaReconciliationService;

    beforeEach(() => {
      jest.clearAllMocks();
      service = new MpesaReconciliationService();
    });

    it("correctly identifies matched records, amount discrepancies, missing callbacks, and duplicates", async () => {
      const parsedRecords = await parseMpesaStatement(sampleCsv);

      // Internal DB records:
      // CONV-1001: matches exactly (1500.00, completed)
      // CONV-1002: amount discrepancy (DB has 1800.00, statement has 2000.00)
      // CONV-1003: missing callback (DB is still pending, statement is Completed)
      // CONV-1004: duplicate disbursement in statement (two rows with CONV-1004)
      // CONV-1099: orphaned in DB (not in statement)
      const mockDbRows = [
        {
          id: "txn-1",
          reference_number: "REF-001",
          provider_reference: "CONV-1001",
          amount: "1500.00",
          status: "completed",
          phone_number: "254712345678",
          provider: "mpesa",
          created_at: "2026-10-16T10:14:00Z",
        },
        {
          id: "txn-2",
          reference_number: "REF-002",
          provider_reference: "CONV-1002",
          amount: "1800.00", // Mismatch with statement (2000.00)
          status: "completed",
          phone_number: "254712345679",
          provider: "mpesa",
          created_at: "2026-10-16T11:19:00Z",
        },
        {
          id: "txn-3",
          reference_number: "REF-003",
          provider_reference: "CONV-1003",
          amount: "500.00",
          status: "pending", // Missing callback!
          phone_number: "254712345680",
          provider: "mpesa",
          created_at: "2026-10-16T12:44:00Z",
        },
        {
          id: "txn-4",
          reference_number: "REF-004",
          provider_reference: "CONV-1004",
          amount: "750.00",
          status: "completed",
          phone_number: "254712345681",
          provider: "mpesa",
          created_at: "2026-10-16T13:59:00Z",
        },
        {
          id: "txn-5",
          reference_number: "REF-099",
          provider_reference: "CONV-1099",
          amount: "300.00",
          status: "completed",
          phone_number: "254712345699",
          provider: "mpesa",
          created_at: "2026-10-16T16:00:00Z",
        },
      ];

      (queryRead as jest.Mock).mockResolvedValueOnce({ rows: mockDbRows });

      const result = await service.reconcile({
        statementRecords: parsedRecords,
        reportDate: new Date("2026-10-16T00:00:00Z"),
        persistToDb: true,
      });

      // Assertions
      expect(result.summary.totalStatementRecords).toBe(5);
      expect(result.summary.totalDbRecords).toBe(5);
      expect(result.summary.totalMatched).toBe(1); // Only CONV-1001 matches completely
      expect(result.matched[0].conversationId).toBe("CONV-1001");

      // Amount discrepancy on CONV-1002
      expect(result.summary.amountDiscrepancies).toBe(1);
      const amountDisc = result.discrepancies.find(
        (d) => d.conversationId === "CONV-1002" && d.type === DiscrepancyType.AmountMismatch,
      );
      expect(amountDisc).toBeDefined();
      expect(amountDisc?.expectedValue).toBe("Amount: 1800.00");
      expect(amountDisc?.actualValue).toBe("Amount: 2000.00");

      // Missing callback on CONV-1003
      expect(result.summary.missingCallbacks).toBe(1);
      const missingCallbackDisc = result.discrepancies.find(
        (d) => d.conversationId === "CONV-1003" && d.type === "missing_callback",
      );
      expect(missingCallbackDisc).toBeDefined();

      // Duplicate disbursement on CONV-1004
      expect(result.summary.duplicateDisbursements).toBeGreaterThanOrEqual(1);
      const dupDisc = result.discrepancies.find(
        (d) => d.conversationId === "CONV-1004" && d.type === "duplicate_disbursement",
      );
      expect(dupDisc).toBeDefined();

      // Orphaned DB record on CONV-1099
      expect(result.summary.orphanedDb).toBe(1);
      const orphanDbDisc = result.discrepancies.find(
        (d) => d.conversationId === "CONV-1099" && d.type === DiscrepancyType.OrphanedDb,
      );
      expect(orphanDbDisc).toBeDefined();

      // DB persistence occurred
      expect(result.reportId).toBe("mock-report-123");
    });
  });
});
