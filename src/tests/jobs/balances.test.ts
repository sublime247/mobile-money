import { runProviderBalanceAlertJob } from "../../jobs/balances";
import { AirtelService } from "../../services/mobilemoney/providers/airtel";
import { MTNProvider } from "../../services/mobilemoney/providers/mtn";

const originalEnv = process.env;

describe("runProviderBalanceAlertJob", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not send alert when balances are above thresholds", async () => {
    process.env.BALANCE_ALERT_WEBHOOK_URL =
      "https://alerts.example.com/webhook";
    process.env.MTN_MIN_BALANCE_THRESHOLD = "1000";
    process.env.AIRTEL_MIN_BALANCE_THRESHOLD = "1000";

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

    await runProviderBalanceAlertJob();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "[balances] All provider balances are above thresholds",
    );
  });

  it("sends alert when any provider balance is below threshold", async () => {
    process.env.BALANCE_ALERT_WEBHOOK_URL =
      "https://alerts.example.com/webhook";
    process.env.MTN_MIN_BALANCE_THRESHOLD = "1000";
    process.env.AIRTEL_MIN_BALANCE_THRESHOLD = "1000";

    jest
      .spyOn(MTNProvider.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 500, currency: "XAF" },
      });

    jest
      .spyOn(AirtelService.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 2000, currency: "NGN" },
      });

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    await runProviderBalanceAlertJob();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; method: string },
    ];
    expect(init.method).toBe("POST");

    const payload = JSON.parse(init.body);
    expect(payload.alertType).toBe("provider_balance_low");
    expect(payload.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "mtn", availableBalance: 500 }),
      ]),
    );

    expect(console.warn).toHaveBeenCalledWith(
      "[balances] Alerted treasury for 1 low balance provider(s)",
    );
  });

  it("warns when low balances are detected but no webhook is configured", async () => {
    delete process.env.BALANCE_ALERT_WEBHOOK_URL;
    delete process.env.TREASURY_ALERT_WEBHOOK_URL;
    delete process.env.SLACK_ALERTS_WEBHOOK_URL;
    delete process.env.EMAIL_ALERT_WEBHOOK_URL;

    jest
      .spyOn(MTNProvider.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 100, currency: "XAF" },
      });

    jest
      .spyOn(AirtelService.prototype, "getOperationalBalance")
      .mockResolvedValue({
        success: true,
        data: { availableBalance: 2000, currency: "NGN" },
      });

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    await runProviderBalanceAlertJob();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[balances] Low provider balances detected but no alert webhook URL is configured",
    );
  });
});
