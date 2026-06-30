const mockPoolQuery = jest.fn();
const mockUpdateStatus = jest.fn();

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
  },
}));

// Mock the entire service module to avoid pulling in axios/provider dependencies
jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn(),
}));

import { runStaleTransactionWatchdog } from "../../src/jobs/staleTransactionWatchdog";
import { MobileMoneyService } from "../../src/services/mobilemoney/mobileMoneyService";

function makeService(
  statusMap: Record<string, "completed" | "failed" | "pending" | "unknown">,
): MobileMoneyService {
  return {
    getTransactionStatus: jest.fn(async (provider: string, ref: string) => ({
      status: statusMap[ref] ?? "unknown",
    })),
  } as unknown as MobileMoneyService;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.STALE_TRANSACTION_HOURS;
});

describe("runStaleTransactionWatchdog", () => {
  it("logs and returns early when no stale transactions exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await runStaleTransactionWatchdog(makeService({}));
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "[stale-watchdog] No stale transactions found",
    );
  });

  it("finalises a completed transaction when provider reports completed", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-1",
          reference_number: "REF-001",
          provider: "mtn",
          created_at: new Date(),
        },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-001": "completed" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-1", "completed");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Resolved as completed"),
    );
  });

  it("expires a transaction when provider reports failed", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-2",
          reference_number: "REF-002",
          provider: "airtel",
          created_at: new Date(),
        },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-002": "failed" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-2", "failed");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Expired as failed"),
    );
  });

  it("expires a transaction when provider reports pending (still stuck)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-3",
          reference_number: "REF-003",
          provider: "orange",
          created_at: new Date(),
        },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-003": "pending" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-3", "failed");
  });

  it("expires a transaction when provider returns unknown", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-4",
          reference_number: "REF-004",
          provider: "mtn",
          created_at: new Date(),
        },
      ],
    });

    await runStaleTransactionWatchdog(makeService({ "REF-004": "unknown" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-4", "failed");
  });

  it("handles multiple transactions with mixed outcomes", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-5",
          reference_number: "REF-005",
          provider: "mtn",
          created_at: new Date(),
        },
        {
          id: "tx-6",
          reference_number: "REF-006",
          provider: "airtel",
          created_at: new Date(),
        },
        {
          id: "tx-7",
          reference_number: "REF-007",
          provider: "orange",
          created_at: new Date(),
        },
      ],
    });

    await runStaleTransactionWatchdog(
      makeService({
        "REF-005": "completed",
        "REF-006": "failed",
        "REF-007": "unknown",
      }),
    );

    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-5", "completed");
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-6", "failed");
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx-7", "failed");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("resolved=1 expired=2 errors=0"),
    );
  });

  it("counts errors and continues when updateStatus throws", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-8",
          reference_number: "REF-008",
          provider: "mtn",
          created_at: new Date(),
        },
      ],
    });
    mockUpdateStatus.mockRejectedValueOnce(new Error("DB error"));

    await runStaleTransactionWatchdog(makeService({ "REF-008": "completed" }));

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Error processing transaction id=tx-8"),
      expect.any(Error),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("errors=1"),
    );
  });

  it("uses STALE_TRANSACTION_HOURS env var in query", async () => {
    process.env.STALE_TRANSACTION_HOURS = "24";
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runStaleTransactionWatchdog(makeService({}));

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("24 hours"),
    );
  });

  it("defaults to 12 hours when env var is not set", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runStaleTransactionWatchdog(makeService({}));

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("12 hours"),
    );
  });
});
