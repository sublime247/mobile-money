const mockPoolQuery = jest.fn();
const mockAddTransactionJob = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

jest.mock("../../src/config/database.js", () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

jest.mock("../../src/queue", () => ({
  addTransactionJob: mockAddTransactionJob,
}));

jest.mock("../../src/queue/index.js", () => ({
  addTransactionJob: mockAddTransactionJob,
}));

import { runCli, showHelp } from "../../src/scripts/momo-cli";
import { pool } from "../../src/config/database";
import { addTransactionJob } from "../../src/queue";
import { TransactionStatus } from "../../src/models/transaction";

describe("momo-cli retry-batch", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;

    // Spy on console methods to assert logs and prevent cluttering test output
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should show help when run with no arguments", async () => {
    await runCli([]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Mobile Money Admin CLI"),
    );
  });

  it("should show help when run with --help or -h", async () => {
    await runCli(["--help"]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Mobile Money Admin CLI"),
    );
  });

  it("should fail when command is retry-batch but batch ID is missing", async () => {
    await runCli(["retry-batch"]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error: Missing batch ID argument."),
    );
    expect(process.exitCode).toBe(1);
  });

  it("should fail when batch ID is not a valid UUID", async () => {
    await runCli(["retry-batch", "invalid-uuid-123"]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error: Invalid batch ID format."),
    );
    expect(process.exitCode).toBe(1);
  });

  it("should warn when no transactions are found for the batch ID", async () => {
    const validUuid = "460010c7-cb10-4828-86d5-bb9f0c299c27";
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await runCli(["retry-batch", validUuid]);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `✗ No transactions found for batch ID: ${validUuid}`,
      ),
    );
  });

  it("should re-queue failed and pending transactions, but ignore completed and cancelled", async () => {
    const validUuid = "460010c7-cb10-4828-86d5-bb9f0c299c27";

    // Simulate finding 4 transactions: 1 completed, 1 cancelled, 1 failed, 1 pending (stuck)
    const mockTransactions = [
      {
        id: "tx-completed",
        referenceNumber: "TX-COMP",
        type: "deposit",
        amount: "1000",
        phoneNumber: "+237670000000",
        provider: "MTN",
        stellarAddress:
          "GA111111111111111111111111111111111111111111111111111111",
        status: TransactionStatus.Completed,
      },
      {
        id: "tx-cancelled",
        referenceNumber: "TX-CANCEL",
        type: "deposit",
        amount: "2000",
        phoneNumber: "+237670000001",
        provider: "AIRTEL",
        stellarAddress:
          "GA222222222222222222222222222222222222222222222222222222",
        status: TransactionStatus.Cancelled,
      },
      {
        id: "tx-failed",
        referenceNumber: "TX-FAIL",
        type: "deposit",
        amount: "3000",
        phoneNumber: "+237670000002",
        provider: "ORANGE",
        stellarAddress:
          "GA333333333333333333333333333333333333333333333333333333",
        status: TransactionStatus.Failed,
      },
      {
        id: "tx-pending",
        referenceNumber: "TX-PEND",
        type: "deposit",
        amount: "4000",
        phoneNumber: "+237670000003",
        provider: "MTN",
        stellarAddress:
          "GA444444444444444444444444444444444444444444444444444444",
        status: TransactionStatus.Pending,
      },
    ];

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: mockTransactions });
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] }); // For updates

    await runCli(["retry-batch", validUuid]);

    // Should fetch transactions using batchId in tags or metadata
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "WHERE tags @> ARRAY[$1]::text[] OR metadata @> $2::jsonb",
      ),
      [validUuid, JSON.stringify({ batchId: validUuid })],
    );

    // Should display summary stats
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Total Transactions: 4"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("✓ Completed: 1"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✗ Failed: 1"));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("⚠ Pending: 1"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("⊘ Cancelled: 1"),
    );

    // Should filter and only retry tx-failed and tx-pending (2 transactions)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Re-queueing 2 transaction(s) for retry..."),
    );

    // Should update status and retry count in database for the 2 retried transactions
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "UPDATE transactions SET status = $1, retry_count = retry_count + 1",
      ),
      [TransactionStatus.Pending, "tx-failed"],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "UPDATE transactions SET status = $1, retry_count = retry_count + 1",
      ),
      [TransactionStatus.Pending, "tx-pending"],
    );

    // Should re-queue using addTransactionJob
    expect(addTransactionJob).toHaveBeenCalledTimes(2);
    expect(addTransactionJob).toHaveBeenNthCalledWith(1, {
      transactionId: "tx-failed",
      type: "deposit",
      amount: "3000",
      phoneNumber: "+237670000002",
      provider: "ORANGE",
      stellarAddress:
        "GA333333333333333333333333333333333333333333333333333333",
    });
    expect(addTransactionJob).toHaveBeenNthCalledWith(2, {
      transactionId: "tx-pending",
      type: "deposit",
      amount: "4000",
      phoneNumber: "+237670000003",
      provider: "MTN",
      stellarAddress:
        "GA444444444444444444444444444444444444444444444444444444",
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Successfully re-queued all 2 transaction(s)"),
    );
  });
});
