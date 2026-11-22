import { runFloatReconciliationJob } from "../floatReconciliationWorker";
import { MTNProvider } from "../../services/mobilemoney/providers/mtn";
import { AirtelService } from "../../services/mobilemoney/providers/airtel";
import { LedgerService } from "../../services/ledgerService";
import { pool } from "../../config/database";
import logger from "../../utils/logger";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

const originalEnv = process.env;

describe("runFloatReconciliationJob", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    jest.spyOn(logger, "error").mockImplementation(() => undefined as any);
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function mockLedgerBalance(balance: number): LedgerService {
    const ledgerService = {
      getAccountBalance: jest.fn().mockResolvedValue(balance),
    } as unknown as LedgerService;
    return ledgerService;
  }

  it("records a reconciliation row per provider and does not alert within tolerance", async () => {
    process.env.FLOAT_RECONCILIATION_TOLERANCE_USD = "50";

    jest
      .spyOn(MTNProvider.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 2000, currency: "XAF" },
      });
    jest
      .spyOn(AirtelService.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 3000, currency: "NGN" },
      });

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    // Combined provider balance (5000) within tolerance of the ledger (4980).
    await runFloatReconciliationJob(mockLedgerBalance(4980));

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Balances reconciled within tolerance"),
    );
  });

  it("alerts and persists the discrepancy when it exceeds tolerance", async () => {
    process.env.FLOAT_RECONCILIATION_TOLERANCE_USD = "50";
    process.env.BALANCE_ALERT_WEBHOOK_URL =
      "https://alerts.example.com/webhook";

    jest
      .spyOn(MTNProvider.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 2000, currency: "XAF" },
      });
    jest
      .spyOn(AirtelService.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 3000, currency: "NGN" },
      });

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    // Combined provider balance (5000) vs ledger (4000) — 1000 diff, way
    // beyond the 50 tolerance.
    await runFloatReconciliationJob(mockLedgerBalance(4000));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; method: string },
    ];
    const payload = JSON.parse(init.body);
    expect(payload.alertType).toBe("provider_float_discrepancy");
    expect(payload.discrepancy).toBeCloseTo(1000);

    // Every reconciliation row is still written, each marked alerted.
    expect(pool.query).toHaveBeenCalledTimes(2);
    const insertCall = (pool.query as jest.Mock).mock.calls[0];
    expect(insertCall[0]).toContain("INSERT INTO provider_balance_ledger");
    expect(insertCall[1][5]).toBe(true); // alerted column
  });

  it("does nothing when no provider balance is available", async () => {
    jest
      .spyOn(MTNProvider.prototype, "getOperationalBalance")
      .mockResolvedValue({ success: false, error: new Error("timeout") });
    jest
      .spyOn(AirtelService.prototype, "getOperationalBalance")
      .mockResolvedValue({ success: false, error: new Error("timeout") });

    const ledgerService = mockLedgerBalance(0);
    await runFloatReconciliationJob(ledgerService);

    expect(ledgerService.getAccountBalance).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[float-reconciliation] No provider balances were available",
    );
  });

  it("warns but does not throw when no alert webhook is configured", async () => {
    delete process.env.BALANCE_ALERT_WEBHOOK_URL;
    delete process.env.TREASURY_ALERT_WEBHOOK_URL;
    delete process.env.SLACK_ALERTS_WEBHOOK_URL;

    jest
      .spyOn(MTNProvider.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 5000, currency: "XAF" },
      });
    jest
      .spyOn(AirtelService.prototype, "getOperationalBalance")
      .mockResolvedValue({ success: false, error: new Error("timeout") });

    await expect(
      runFloatReconciliationJob(mockLedgerBalance(0)),
    ).resolves.not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      "[float-reconciliation] Discrepancy detected but no alert webhook URL is configured",
    );
  });
});
