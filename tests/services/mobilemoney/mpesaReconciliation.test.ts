import {
  MpesaReconciliationEngine,
  MpesaStatementRecord,
  InternalDisbursementRecord,
  DiscrepancyType,
} from "../../../src/services/mobilemoney/mpesaReconciliation";
import { MpesaReconciliationJob } from "../../../src/jobs/mpesaReconciliationJob";

describe("M-Pesa B2C Daily Reconciliation Service (Issue #2129)", () => {
  const sampleCsv = `Receipt No., Completion Time, ConversationID, Details, Transaction Status, Paid In, Withdrawn, Balance
NL12345678, 2026-10-02 08:30:00, conv_001, B2C Disbursement, Completed, 0, 500.00, 150000.00
NL12345679, 2026-10-02 08:31:00, conv_002, B2C Disbursement, Completed, 0, 250.00, 149750.00
NL12345680, 2026-10-02 08:32:00, conv_003, B2C Disbursement, Failed, 0, 100.00, 149750.00`;

  it("should parse M-Pesa CSV statement into structured records", () => {
    const records = MpesaReconciliationEngine.parseStatementCsv(sampleCsv);
    expect(records).toHaveLength(3);
    expect(records[0].receiptNo).toBe("NL12345678");
    expect(records[0].withdrawn).toBe(500.0);
    expect(records[0].status).toBe("Completed");
  });

  it("should reconcile matching records with 100% volume accuracy", () => {
    const records = MpesaReconciliationEngine.parseStatementCsv(sampleCsv);
    const internalRecords: InternalDisbursementRecord[] = [
      {
        id: "disb_1",
        conversationId: "conv_001",
        amount: 500.0,
        currency: "KES",
        status: "completed",
        createdAt: "2026-10-02T08:30:00Z",
      },
      {
        id: "disb_2",
        conversationId: "conv_002",
        amount: 250.0,
        currency: "KES",
        status: "completed",
        createdAt: "2026-10-02T08:31:00Z",
      },
      {
        id: "disb_3",
        conversationId: "conv_003",
        amount: 100.0,
        currency: "KES",
        status: "failed",
        createdAt: "2026-10-02T08:32:00Z",
      },
    ];

    const summary = MpesaReconciliationEngine.reconcile(
      records,
      internalRecords,
      "2026-10-02",
    );
    expect(summary.status).toBe("RECONCILED");
    expect(summary.matchedCount).toBe(3);
    expect(summary.matchedVolume).toBe(850.0);
    expect(summary.discrepancies).toHaveLength(0);
  });

  it("should detect AMOUNT_MISMATCH, STATUS_MISMATCH, and MISSING records", () => {
    const records = MpesaReconciliationEngine.parseStatementCsv(sampleCsv);
    const internalRecords: InternalDisbursementRecord[] = [
      {
        id: "disb_1",
        conversationId: "conv_001",
        amount: 450.0, // Mismatch (statement is 500)
        currency: "KES",
        status: "completed",
        createdAt: "2026-10-02T08:30:00Z",
      },
      {
        id: "disb_2",
        conversationId: "conv_002",
        amount: 250.0,
        currency: "KES",
        status: "pending", // Status mismatch (statement is Completed)
        createdAt: "2026-10-02T08:31:00Z",
      },
      {
        id: "disb_4",
        conversationId: "conv_004", // Missing in statement
        amount: 120.0,
        currency: "KES",
        status: "completed",
        createdAt: "2026-10-02T08:35:00Z",
      },
    ];

    const summary = MpesaReconciliationEngine.reconcile(
      records,
      internalRecords,
      "2026-10-02",
    );
    expect(summary.status).toBe("ACTION_REQUIRED");

    const types = summary.discrepancies.map((d) => d.type);
    expect(types).toContain(DiscrepancyType.AMOUNT_MISMATCH);
    expect(types).toContain(DiscrepancyType.STATUS_MISMATCH);
    expect(types).toContain(DiscrepancyType.MISSING_IN_INTERNAL);
    expect(types).toContain(DiscrepancyType.MISSING_IN_PROVIDER);
  });

  it("should execute daily reconciliation via MpesaReconciliationJob", async () => {
    const job = new MpesaReconciliationJob();
    const internalRecords: InternalDisbursementRecord[] = [
      {
        id: "disb_1",
        conversationId: "conv_001",
        amount: 500.0,
        currency: "KES",
        status: "completed",
        createdAt: "2026-10-02T08:30:00Z",
      },
    ];

    const singleCsv = `Receipt No., Completion Time, ConversationID, Details, Transaction Status, Paid In, Withdrawn, Balance
NL12345678, 2026-10-02 08:30:00, conv_001, B2C Disbursement, Completed, 0, 500.00, 150000.00`;

    const summary = await job.runDailyReconciliation(
      singleCsv,
      internalRecords,
      "2026-10-02",
    );
    expect(summary.status).toBe("RECONCILED");
    expect(summary.matchedCount).toBe(1);
  });
});
