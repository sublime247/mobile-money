import { MobileMoneyService } from "../../../src/services/mobilemoney/mobileMoneyService";
import { resetCircuitBreakers } from "../../../src/utils/circuitBreaker";

type FakeResult = {
  success: boolean;
  data?: unknown;
  error?: unknown;
  delayMs?: number;
};

class FakeProvider {
  requestPaymentCalls = 0;
  sendPayoutCalls = 0;

  constructor(
    private requestPaymentResults: FakeResult[],
    private sendPayoutResults: FakeResult[] = requestPaymentResults,
    private name = "fake",
  ) {}

  async requestPayment(_phoneNumber: string, _amount: string) {
    this.requestPaymentCalls += 1;
    return this.consume(this.requestPaymentResults, "requestPayment");
  }

  async sendPayout(_phoneNumber: string, _amount: string) {
    this.sendPayoutCalls += 1;
    return this.consume(this.sendPayoutResults, "sendPayout");
  }

  private async consume(results: FakeResult[], operation: string) {
    const next = results.shift() ?? {
      success: true,
      data: { reference: `${this.name}-${operation}-default` },
    };

    if (next.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }

    if (next.success) {
      return {
        success: true,
        data:
          next.data ?? { reference: `${this.name}-${operation}-${Date.now()}` },
      };
    }

    return {
      success: false,
      error: next.error ?? new Error(`${this.name}-${operation}-failed`),
    };
  }
}

describe("MobileMoneyService failover", () => {
  beforeEach(() => {
    process.env.PROVIDER_FAILOVER_ENABLED = "true";
    process.env.PROVIDER_BACKUP_MTN = "airtel";
    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "3";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "50";
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "1000";
    resetCircuitBreakers();
  });

  afterEach(() => {
    resetCircuitBreakers();
    delete process.env.PROVIDER_BACKUP_MTN;
  });

  it("fails over to backup when the primary provider returns an error", async () => {
    const providers = new Map();
    providers.set(
      "mtn",
      new FakeProvider([{ success: false, error: new Error("mtn-down") }], [], "mtn"),
    );
    providers.set("airtel", new FakeProvider([{ success: true }], [], "airtel"));

    const service = new MobileMoneyService(providers as any);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await service.initiatePayment("mtn", "+111111111", "100");

    expect(result.success).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failing over from mtn to airtel"),
    );

    warn.mockRestore();
  });

  it("quickly short-circuits to the backup provider once the primary circuit is open", async () => {
    const primary = new FakeProvider(
      [
        { success: false, error: new Error("mtn-1") },
        { success: false, error: new Error("mtn-2") },
        { success: false, error: new Error("mtn-3") },
        { success: true, delayMs: 250, data: { reference: "mtn-late" } },
      ],
      [],
      "mtn",
    );
    const backup = new FakeProvider(
      [
        { success: true, data: { reference: "airtel-1" } },
        { success: true, data: { reference: "airtel-2" } },
        { success: true, data: { reference: "airtel-3" } },
        { success: true, data: { reference: "airtel-4" } },
      ],
      [],
      "airtel",
    );

    const service = new MobileMoneyService(
      new Map([
        ["mtn", primary],
        ["airtel", backup],
      ]) as any,
    );

    await service.initiatePayment("mtn", "+1", "10");
    await service.initiatePayment("mtn", "+2", "10");
    await service.initiatePayment("mtn", "+3", "10");

    expect(primary.requestPaymentCalls).toBe(3);

    const startedAt = Date.now();
    const result = await service.initiatePayment("mtn", "+4", "10");
    const elapsedMs = Date.now() - startedAt;

    expect(result.success).toBe(true);
    expect(primary.requestPaymentCalls).toBe(3);
    expect(backup.requestPaymentCalls).toBe(4);
    expect(elapsedMs).toBeLessThan(100);
  });

  it("recovers gracefully after the reset timeout and sends traffic back to the primary provider", async () => {
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "50";

    const primary = new FakeProvider(
      [
        { success: false, error: new Error("mtn-1") },
        { success: false, error: new Error("mtn-2") },
        { success: false, error: new Error("mtn-3") },
        { success: true, data: { reference: "mtn-recovered" } },
      ],
      [],
      "mtn",
    );
    const backup = new FakeProvider(
      [
        { success: true, data: { reference: "airtel-1" } },
        { success: true, data: { reference: "airtel-2" } },
        { success: true, data: { reference: "airtel-3" } },
      ],
      [],
      "airtel",
    );

    const service = new MobileMoneyService(
      new Map([
        ["mtn", primary],
        ["airtel", backup],
      ]) as any,
    );

    await service.initiatePayment("mtn", "+1", "10");
    await service.initiatePayment("mtn", "+2", "10");
    await service.initiatePayment("mtn", "+3", "10");

    await new Promise((resolve) => setTimeout(resolve, 80));

    const result = await service.initiatePayment("mtn", "+4", "10");

    expect(result).toEqual({
      success: true,
      data: { reference: "mtn-recovered" },
    });
    expect(primary.requestPaymentCalls).toBe(4);
    expect(backup.requestPaymentCalls).toBe(3);
  });

  it("throws when both the primary and backup providers fail", async () => {
    const service = new MobileMoneyService(
      new Map([
        [
          "mtn",
          new FakeProvider([{ success: false, error: new Error("mtn-down") }], [], "mtn"),
        ],
        [
          "airtel",
          new FakeProvider(
            [{ success: false, error: new Error("airtel-down") }],
            [],
            "airtel",
          ),
        ],
      ]) as any,
    );

    await expect(
      service.initiatePayment("mtn", "+111111111", "100"),
    ).rejects.toThrow("backup provider 'airtel' failed");
  });

  it("notifies on repeated failovers", async () => {
    const service = new MobileMoneyService(
      new Map([
        [
          "mtn",
          new FakeProvider(
            [
              { success: false, error: new Error("mtn-1") },
              { success: false, error: new Error("mtn-2") },
              { success: false, error: new Error("mtn-3") },
            ],
            [],
            "mtn",
          ),
        ],
        [
          "airtel",
          new FakeProvider(
            [{ success: true }, { success: true }, { success: true }],
            [],
            "airtel",
          ),
        ],
      ]) as any,
    );

    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    await service.initiatePayment("mtn", "+1", "10");
    await service.initiatePayment("mtn", "+2", "10");
    await service.initiatePayment("mtn", "+3", "10");

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Failover alert: provider=mtn"),
    );

    error.mockRestore();
  });
});
