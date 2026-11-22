import { checkAirtelBalanceAndAlert } from "../../src/jobs/balanceMonitorJob";
import { AirtelService } from "../../src/services/providers/airtelService";
import { notifySlackAlert } from "../../src/services/loggers";

jest.mock("../../src/services/providers/airtelService");
jest.mock("../../src/services/loggers");
jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

describe("Airtel Balance Monitor Job", () => {
  let mockGetBalance: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBalance = jest.fn();
    (AirtelService as jest.Mock).mockImplementation(() => {
      return {
        getBalance: mockGetBalance,
      };
    });
    process.env.AIRTEL_LOW_BALANCE_THRESHOLD = "50000";
  });

  it("should not alert if balance is above threshold", async () => {
    mockGetBalance.mockResolvedValue({
      success: true,
      data: { availableBalance: 60000, currency: "NGN" },
    });

    await checkAirtelBalanceAndAlert();

    expect(notifySlackAlert).not.toHaveBeenCalled();
    const { pool } = require("../../src/config/database");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO provider_balance_snapshots"),
      ["airtel", 60000, "NGN"]
    );
  });

  it("should trigger alert if balance is below threshold", async () => {
    mockGetBalance.mockResolvedValue({
      success: true,
      data: { availableBalance: 40000, currency: "NGN" },
    });

    await checkAirtelBalanceAndAlert();

    expect(notifySlackAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
      }),
      expect.objectContaining({
        appName: "airtel-balance-monitor",
      })
    );

    const { pool } = require("../../src/config/database");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO provider_balance_snapshots"),
      ["airtel", 40000, "NGN"]
    );
  });

  it("should handle error gracefully if balance fetch fails", async () => {
    mockGetBalance.mockResolvedValue({
      success: false,
      error: "API timeout",
    });

    await checkAirtelBalanceAndAlert();

    expect(notifySlackAlert).not.toHaveBeenCalled();
    const { pool } = require("../../src/config/database");
    expect(pool.query).not.toHaveBeenCalled();
  });
});
