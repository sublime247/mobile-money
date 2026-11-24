import { queryRead } from "../../config/database";
import { KYCLevel } from "../../config/limits";
import { KYCService } from "../kyc/kycService";
import { TransactionModel } from "../../models/transaction";
import { TransactionLimitService } from "../transactionLimit/transactionLimitService";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  queryRead: jest.fn(),
}));

describe("TransactionLimitService KYC volume caps", () => {
  const service = new TransactionLimitService(
    { getUserKYCLevel: jest.fn().mockResolvedValue(KYCLevel.Basic) } as unknown as KYCService,
    { findCompletedByUserSince: jest.fn().mockResolvedValue([]) } as unknown as TransactionModel,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a transaction that would exceed the rolling 24-hour tier cap", async () => {
    (queryRead as jest.Mock)
      .mockResolvedValueOnce({
        rows: [
          {
            currency: "USD",
            daily_usd_total: "2800",
            monthly_usd_total: "2800",
            daily_unconverted_total: "0",
            monthly_unconverted_total: "0",
          },
        ],
      });

    const result = await service.checkTransactionLimit("user-1", 250, "USD");

    expect(result.allowed).toBe(false);
    expect(result.dailyLimitUsd).toBe(3000);
    expect(result.monthlyLimitUsd).toBe(90000);
    expect(result.currentDailyTotalUsd).toBe(2800);
    expect(result.upgradeAvailable).toBe(true);
    expect(queryRead).toHaveBeenCalledWith(
      expect.stringContaining("INTERVAL '24 hours'"),
      ["user-1"],
    );
  });

  it("rejects a transaction that would exceed the rolling 30-day tier cap", async () => {
    (queryRead as jest.Mock)
      .mockResolvedValueOnce({
        rows: [
          {
            currency: "USD",
            daily_usd_total: "100",
            monthly_usd_total: "89900",
            daily_unconverted_total: "0",
            monthly_unconverted_total: "0",
          },
        ],
      });

    const result = await service.checkTransactionLimit("user-1", 200, "USD");

    expect(result.allowed).toBe(false);
    expect(result.message).toContain("30-day");
    expect(result.currentMonthlyTotalUsd).toBe(89900);
  });
});
