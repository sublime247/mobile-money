import { runCrossChainMonitorJob } from "../../src/jobs/crossChainMonitorJob";
import { CrossChainMonitorService } from "../../src/services/crossChainMonitorService";

jest.mock("../../src/services/crossChainMonitorService");
jest.mock("../../src/config/stellar");
jest.mock("../../src/utils/metrics", () => ({
  crossChainBalanceGauge: { set: jest.fn() },
  crossChainAnomalyTotal: { inc: jest.fn() },
}));

const mockSnapshot = jest.fn();
jest.mocked(CrossChainMonitorService.getInstance).mockReturnValue({
  snapshot: mockSnapshot,
  getLastSnapshot: jest.fn().mockReturnValue([]),
} as any);

describe("runCrossChainMonitorJob", () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("calls CrossChainMonitorService.getInstance().snapshot()", async () => {
    mockSnapshot.mockResolvedValue([]);
    await runCrossChainMonitorJob();
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it("logs the number of snapshots captured", async () => {
    const fakeSnapshots = [
      {
        chain: "stellar",
        asset: "XLM",
        address: "GABC",
        balance: "10",
        capturedAt: new Date(),
      },
      {
        chain: "mtn",
        asset: "XAF",
        address: "mtn",
        balance: "0",
        capturedAt: new Date(),
      },
    ];
    mockSnapshot.mockResolvedValue(fakeSnapshots);

    await runCrossChainMonitorJob();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[cross-chain-monitor] Captured 2 asset snapshot(s)",
    );
  });

  it("logs zero snapshots when service returns empty array", async () => {
    mockSnapshot.mockResolvedValue([]);

    await runCrossChainMonitorJob();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[cross-chain-monitor] Captured 0 asset snapshot(s)",
    );
  });

  it("propagates errors thrown by snapshot()", async () => {
    mockSnapshot.mockRejectedValue(new Error("Stellar network error"));

    await expect(runCrossChainMonitorJob()).rejects.toThrow(
      "Stellar network error",
    );
  });
});
