import { runStatusCheckJob } from "./statusCheckJob";

jest.mock("../config/database", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../services/mobilemoney/providers/airtel", () => ({
  AirtelService: jest.fn().mockImplementation(() => ({
    checkStatus: jest.fn(),
  })),
}));

jest.mock("../services/mobilemoney/providers/orange", () => ({
  OrangeProvider: jest.fn().mockImplementation(() => ({
    checkStatus: jest.fn(),
  })),
}));

jest.mock("../services/mobilemoney/providers/mtn", () => ({
  MTNProvider: jest.fn().mockImplementation(() => ({
    checkStatus: jest.fn(),
  })),
}));

import { pool } from "../config/database";
import { AirtelService } from "../services/mobilemoney/providers/airtel";

const mockQuery = pool.query as jest.Mock;
const MockAirtelService = AirtelService as jest.Mock;

describe("runStatusCheckJob watchdog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.STALE_TRANSACTION_HOURS;
    delete process.env.STUCK_TRANSACTION_MINUTES;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs when no stale pending transactions are found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await runStatusCheckJob();

    expect(console.log).toHaveBeenCalledWith(
      "[status-check] No stuck transactions found",
    );
  });

  it("marks stale transaction completed when provider returns successful status", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-1",
          reference_number: "TXN-001",
          provider: "airtel",
          created_at: new Date("2026-04-22T00:00:00Z"),
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const airtelInstance = { checkStatus: jest.fn().mockResolvedValue({ success: true, data: { status: "SUCCESSFUL" } }) };
    MockAirtelService.mockImplementationOnce(() => airtelInstance);

    await runStatusCheckJob();

    expect(airtelInstance.checkStatus).toHaveBeenCalledWith("TXN-001");
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE transactions");
    expect(updateCall[1][0]).toBe("completed");
    expect(updateCall[1][2]).toBe("tx-1");
  });

  it("expires stale transaction when provider still returns pending", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-2",
          reference_number: "TXN-002",
          provider: "airtel",
          created_at: new Date("2026-04-22T00:00:00Z"),
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const airtelInstance = { checkStatus: jest.fn().mockResolvedValue({ success: true, data: { status: "PENDING" } }) };
    MockAirtelService.mockImplementationOnce(() => airtelInstance);

    await runStatusCheckJob();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][0]).toBe("failed");
    expect(updateCall[1][2]).toBe("tx-2");
    const metadata = JSON.parse(updateCall[1][1]);
    expect(metadata.watchdog.reason).toBe("EXPIRED");
  });
});
