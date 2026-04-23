const mockPoolQuery = jest.fn();
const mockGetTransactionStatus = jest.fn();
const mockUpdateStatus = jest.fn();
const mockPatchMetadata = jest.fn();

jest.mock("../config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

jest.mock("../services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({
    getTransactionStatus: (...args: unknown[]) => mockGetTransactionStatus(...args),
  })),
}));

jest.mock("../models/transaction", () => ({
  TransactionStatus: {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
    Cancelled: "cancelled",
  },
  TransactionModel: jest.fn().mockImplementation(() => ({
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
    patchMetadata: (...args: unknown[]) => mockPatchMetadata(...args),
  })),
}));

import { runStatusCheckJob } from "./statusCheckJob";

describe("runStatusCheckJob watchdog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateStatus.mockResolvedValue(undefined);
    mockPatchMetadata.mockResolvedValue(undefined);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STALE_TRANSACTION_HOURS;
  });

  it("does nothing when no stale pending transactions are found", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runStatusCheckJob();

    expect(console.log).toHaveBeenCalledWith(
      "[status-check] No stale pending transactions found",
    );
    expect(mockGetTransactionStatus).not.toHaveBeenCalled();
  });

  it("finalizes stale transaction as completed when provider reports success", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx-1", provider: "airtel", reference_number: "REF-1" }],
    });
    mockGetTransactionStatus.mockResolvedValueOnce({
      success: true,
      data: { status: "completed" },
    });

    await runStatusCheckJob();

    expect(mockGetTransactionStatus).toHaveBeenCalledWith("airtel", "REF-1");
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-1", "completed");
    expect(mockPatchMetadata).toHaveBeenCalledWith(
      "tx-1",
      expect.objectContaining({
        watchdog: expect.objectContaining({
          providerStatus: "COMPLETED",
          resolvedBy: "stale-transaction-watchdog",
        }),
      }),
    );
  });

  it("marks stale transaction as EXPIRED when provider check fails", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx-2", provider: "mtn", reference_number: "REF-2" }],
    });
    mockGetTransactionStatus.mockResolvedValueOnce({
      success: false,
      error: new Error("provider down"),
    });

    await runStatusCheckJob();

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-2", "failed");
    expect(mockPatchMetadata).toHaveBeenCalledWith(
      "tx-2",
      expect.objectContaining({
        watchdog: expect.objectContaining({
          reason: "EXPIRED",
          provider: "mtn",
          referenceNumber: "REF-2",
        }),
      }),
    );
  });

  it("uses STALE_TRANSACTION_HOURS override", async () => {
    process.env.STALE_TRANSACTION_HOURS = "6";
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runStatusCheckJob();

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("INTERVAL '1 hour'"),
      [6],
    );
  });
});
