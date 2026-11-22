const mockPoolQuery = jest.fn();
const mockUpdateStatus = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
  })),
  TransactionStatus: {
    Completed: "completed",
    Failed: "failed",
    Expired: "expired",
  },
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

// Mock the entire service module to avoid pulling in axios/provider dependencies
jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn(),
}));

import { runStaleTransactionWatchdog } from "../../src/jobs/staleTransactionWatchdog";
import { MobileMoneyService } from "../../src/services/mobilemoney/mobileMoneyService";

function makeService(
  statusMap: Record<
    string,
    "completed" | "successful" | "failed" | "rejected" | "pending" | "unknown"
  >,
): MobileMoneyService {
  return {
    getTransactionStatus: jest.fn(async (provider: string, ref: string) => ({
      success: true,
      data: { status: statusMap[ref] ?? "unknown" },
    })),
  } as unknown as MobileMoneyService;
}

function makeUnreachableService(): MobileMoneyService {
  return {
    getTransactionStatus: jest.fn(async () => ({
      success: false,
      error: "provider unreachable",
    })),
  } as unknown as MobileMoneyService;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  delete process.env.STALE_TRANSACTION_HOURS;
});

describe("runStaleTransactionWatchdog", () => {
  it("logs and returns early when no stale transactions exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await runStaleTransactionWatchdog(makeService({}));
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith("No stale transactions found");
  });

  it("finalises a completed transaction when provider reports completed", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-1", reference_number: "REF-001", provider: "mtn", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-001": "completed" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-1", "completed");
  });

  it("finalises a completed transaction when provider reports successful", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-1b", reference_number: "REF-001B", provider: "mtn", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-001B": "successful" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-1b", "completed");
  });

  it("finalises as failed when the provider actually reports failed (issue #1793)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-2", reference_number: "REF-002", provider: "airtel", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-002": "failed" }));

    // A genuine provider-reported failure is Failed, not Expired.
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-2", "failed");
  });

  it("finalises as failed when the provider reports rejected", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-2b", reference_number: "REF-002B", provider: "airtel", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-002B": "rejected" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-2b", "failed");
  });

  it("finalises as expired (not failed) when the provider still reports pending (issue #1793)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-3", reference_number: "REF-003", provider: "orange", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-003": "pending" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-3", "expired");
    expect(mockUpdateStatus).not.toHaveBeenCalledWith("tx-3", "failed");
  });

  it("finalises as expired (not failed) when the provider returns unknown (issue #1793)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-4", reference_number: "REF-004", provider: "mtn", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-004": "unknown" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-4", "expired");
  });

  it("finalises as expired (not failed) when the provider is unreachable (issue #1793)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-4b", reference_number: "REF-004B", provider: "mtn", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(makeUnreachableService());

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-4b", "expired");
    expect(mockUpdateStatus).not.toHaveBeenCalledWith("tx-4b", "failed");
  });

  it("handles multiple transactions with mixed outcomes, correctly separating failed from expired", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-5", reference_number: "REF-005", provider: "mtn", created_at: new Date() },
        { id: "tx-6", reference_number: "REF-006", provider: "airtel", created_at: new Date() },
        { id: "tx-7", reference_number: "REF-007", provider: "orange", created_at: new Date() },
      ],
    });

    await runStaleTransactionWatchdog(
      makeService({ "REF-005": "completed", "REF-006": "failed", "REF-007": "unknown" }),
    );

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-5", "completed");
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-6", "failed");
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-7", "expired");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { resolved: 2, expired: 1, errors: 0 },
      "Stale transaction watchdog completed",
    );
  });

  it("counts errors and continues when updateStatus throws", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "tx-8", reference_number: "REF-008", provider: "mtn", created_at: new Date() },
      ],
    });
    mockUpdateStatus.mockRejectedValueOnce(new Error("DB error"));

    await runStaleTransactionWatchdog(makeService({ "REF-008": "completed" }));

    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: expect.any(Error), transactionId: "tx-8" },
      "Error processing stale transaction",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { resolved: 0, expired: 0, errors: 1 },
      "Stale transaction watchdog completed",
    );
  });

  it("uses STALE_TRANSACTION_HOURS env var in query", async () => {
    process.env.STALE_TRANSACTION_HOURS = "24";
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runStaleTransactionWatchdog(makeService({}));

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining("24 hours"));
  });

  it("defaults to 12 hours when env var is not set", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runStaleTransactionWatchdog(makeService({}));

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining("12 hours"));
  });
});
