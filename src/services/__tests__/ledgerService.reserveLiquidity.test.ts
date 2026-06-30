import { LedgerService } from "../ledgerService";
import { Pool } from "pg";

jest.mock("../loggers", () => ({
  notifySlackAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../pagerDutyService", () => ({
  createPagerDutyService: jest.fn(() => ({
    handleBalanceShortfall: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { notifySlackAlert } from "../loggers";
import { createPagerDutyService } from "../pagerDutyService";

function makePool(rows: { provider: string; volume: string }[]): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
    connect: jest.fn(),
  } as unknown as Pool;
}

describe("LedgerService.checkReserveLiquidity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RESERVE_LIQUIDITY_RATIO;
    delete process.env.RESERVE_PEAK_MONTHS;
    delete process.env.RESERVE_SEASONAL_PEAK_MULTIPLIER;
  });

  it("triggers PagerDuty and Slack when balance is below 110% of 30-day volume", async () => {
    // 30-day volume = 1000; balance = 1000; ratio = 1.0 < 1.1 → alert
    const service = new LedgerService(
      makePool([{ provider: "mtn", volume: "1000" }]),
    );
    await service.checkReserveLiquidity({ mtn: 1000 });

    const pd = (createPagerDutyService as jest.Mock).mock.results[0].value;
    expect(pd.handleBalanceShortfall).toHaveBeenCalledWith(
      "mtn",
      "reserve-liquidity",
      expect.any(Number),
      1000,
    );
    expect(notifySlackAlert).toHaveBeenCalledTimes(1);
  });

  it("does NOT alert when balance is at or above 110% of 30-day volume", async () => {
    // 30-day volume = 1000; balance = 1100; ratio = 1.1 → no alert
    const service = new LedgerService(
      makePool([{ provider: "airtel", volume: "1000" }]),
    );
    await service.checkReserveLiquidity({ airtel: 1100 });

    const pd = (createPagerDutyService as jest.Mock).mock.results[0].value;
    expect(pd.handleBalanceShortfall).not.toHaveBeenCalled();
    expect(notifySlackAlert).not.toHaveBeenCalled();
  });

  it("skips providers with zero 30-day velocity", async () => {
    const service = new LedgerService(makePool([])); // no ledger data
    await service.checkReserveLiquidity({ mtn: 500 });

    const pd = (createPagerDutyService as jest.Mock).mock.results[0].value;
    expect(pd.handleBalanceShortfall).not.toHaveBeenCalled();
  });

  it("applies seasonal peak multiplier during peak months", async () => {
    // Force current month to be a peak month
    const currentMonth = new Date().getMonth() + 1;
    process.env.RESERVE_PEAK_MONTHS = String(currentMonth);
    process.env.RESERVE_SEASONAL_PEAK_MULTIPLIER = "1.5";

    // volume=1000, seasonal=1.5 → expectedVolume=1500, threshold=1650
    // balance=1400 → ratio = 1400/1500 ≈ 0.93 < 1.1 → alert
    const service = new LedgerService(
      makePool([{ provider: "mtn", volume: "1000" }]),
    );
    await service.checkReserveLiquidity({ mtn: 1400 });

    const pd = (createPagerDutyService as jest.Mock).mock.results[0].value;
    // threshold passed should be 1500 * 1.1 = 1650
    expect(pd.handleBalanceShortfall).toHaveBeenCalledWith(
      "mtn",
      "reserve-liquidity",
      expect.closeTo(1650, 5),
      1400,
    );
  });

  it("does not alert outside peak months", async () => {
    // Set a peak month that is NOT the current month
    const nonPeakMonth = ((new Date().getMonth() + 1) % 12) + 1; // always different
    process.env.RESERVE_PEAK_MONTHS = String(nonPeakMonth);
    process.env.RESERVE_SEASONAL_PEAK_MULTIPLIER = "2.0";

    // volume=1000, no seasonal → threshold=1100; balance=1100 → no alert
    const service = new LedgerService(
      makePool([{ provider: "mtn", volume: "1000" }]),
    );
    await service.checkReserveLiquidity({ mtn: 1100 });

    const pd = (createPagerDutyService as jest.Mock).mock.results[0].value;
    expect(pd.handleBalanceShortfall).not.toHaveBeenCalled();
  });
});
