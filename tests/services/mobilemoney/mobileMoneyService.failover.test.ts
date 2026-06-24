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
    delete process.env.PROVIDER_FAILOVER_CHAIN_MTN;
  });

  // ── Single backup (backward compat) ─────────────────────────────────

  it("fails over to backup when the primary provider returns a transient error", async () => {
    const providers = new Map();
    providers.set(
      "mtn",
      new FakeProvider(
        [{ success: false, error: new Error("timeout connecting to mtn") }],
        [],
        "mtn",
      ),
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
        { success: false, error: new Error("timeout mtn-1") },
        { success: false, error: new Error("timeout mtn-2") },
        { success: false, error: new Error("timeout mtn-3") },
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
        { success: false, error: new Error("timeout mtn-1") },
        { success: false, error: new Error("timeout mtn-2") },
        { success: false, error: new Error("timeout mtn-3") },
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

  it("throws when both the primary and backup providers fail with transient errors", async () => {
    const service = new MobileMoneyService(
      new Map([
        [
          "mtn",
          new FakeProvider(
            [
              {
                success: false,
                error: new Error("timeout: mtn-down"),
              },
            ],
            [],
            "mtn",
          ),
        ],
        [
          "airtel",
          new FakeProvider(
            [
              {
                success: false,
                error: new Error("timeout: airtel-down"),
              },
            ],
            [],
            "airtel",
          ),
        ],
      ]) as any,
    );

    await expect(
      service.initiatePayment("mtn", "+111111111", "100"),
    ).rejects.toThrow(/providers exhausted|airtel.*failed/);
  });

  it("notifies on repeated failovers", async () => {
    const service = new MobileMoneyService(
      new Map([
        [
          "mtn",
          new FakeProvider(
            [
              { success: false, error: new Error("timeout mtn-1") },
              { success: false, error: new Error("timeout mtn-2") },
              { success: false, error: new Error("timeout mtn-3") },
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

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await service.initiatePayment("mtn", "+1", "10");
    await service.initiatePayment("mtn", "+2", "10");
    await service.initiatePayment("mtn", "+3", "10");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failover alert: provider=mtn"),
    );

    errorSpy.mockRestore();
  });

  // ── Multi-provider failover chain ───────────────────────────────────

  describe("failover chain (mapping array)", () => {
    it("fails over through a chain of 3 providers using PROVIDER_FAILOVER_CHAIN_ env var", async () => {
      delete process.env.PROVIDER_BACKUP_MTN;
      process.env.PROVIDER_FAILOVER_CHAIN_MTN = "airtel,orange,tigo";

      const mtn = new FakeProvider(
        [{ success: false, error: new Error("timeout mtn") }],
        [],
        "mtn",
      );
      const airtel = new FakeProvider(
        [{ success: false, error: new Error("timeout airtel") }],
        [],
        "airtel",
      );
      const orange = new FakeProvider(
        [{ success: true, data: { reference: "orange-final" } }],
        [],
        "orange",
      );

      const service = new MobileMoneyService(
        new Map([
          ["mtn", mtn],
          ["airtel", airtel],
          ["orange", orange],
        ]) as any,
      );

      const result = await service.initiatePayment("mtn", "+255700000000", "1000");

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ reference: "orange-final" });
      expect(mtn.requestPaymentCalls).toBe(1);
      expect(airtel.requestPaymentCalls).toBe(1);
      expect(orange.requestPaymentCalls).toBe(1);
    });

    it("stops at the first successful provider in the chain", async () => {
      delete process.env.PROVIDER_BACKUP_MTN;
      process.env.PROVIDER_FAILOVER_CHAIN_MTN = "airtel,orange";

      const mtn = new FakeProvider(
        [{ success: false, error: new Error("timeout mtn") }],
        [],
        "mtn",
      );
      const airtel = new FakeProvider(
        [{ success: true, data: { reference: "airtel-success" } }],
        [],
        "airtel",
      );
      const orange = new FakeProvider(
        [{ success: true, data: { reference: "orange-not-called" } }],
        [],
        "orange",
      );

      const service = new MobileMoneyService(
        new Map([
          ["mtn", mtn],
          ["airtel", airtel],
          ["orange", orange],
        ]) as any,
      );

      const result = await service.initiatePayment("mtn", "+255700000000", "1000");

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ reference: "airtel-success" });
      expect(mtn.requestPaymentCalls).toBe(1);
      expect(airtel.requestPaymentCalls).toBe(1);
      expect(orange.requestPaymentCalls).toBe(0);
    });

    it("exhausts all providers in the chain and throws", async () => {
      delete process.env.PROVIDER_BACKUP_MTN;
      process.env.PROVIDER_FAILOVER_CHAIN_MTN = "airtel,orange";

      const mtn = new FakeProvider(
        [{ success: false, error: new Error("timeout mtn") }],
        [],
        "mtn",
      );
      const airtel = new FakeProvider(
        [{ success: false, error: new Error("timeout airtel") }],
        [],
        "airtel",
      );
      const orange = new FakeProvider(
        [{ success: false, error: new Error("timeout orange") }],
        [],
        "orange",
      );

      const service = new MobileMoneyService(
        new Map([
          ["mtn", mtn],
          ["airtel", airtel],
          ["orange", orange],
        ]) as any,
      );

      await expect(
        service.initiatePayment("mtn", "+255700000000", "1000"),
      ).rejects.toThrow(/All failover providers exhausted/);

      expect(mtn.requestPaymentCalls).toBe(1);
      expect(airtel.requestPaymentCalls).toBe(1);
      expect(orange.requestPaymentCalls).toBe(1);
    });

    it("does NOT failover on non-transient (validation) errors", async () => {
      delete process.env.PROVIDER_BACKUP_MTN;
      process.env.PROVIDER_FAILOVER_CHAIN_MTN = "airtel,orange";

      const mtn = new FakeProvider(
        [
          {
            success: false,
            error: new Error("invalid request: bad phone number"),
          },
        ],
        [],
        "mtn",
      );
      const airtel = new FakeProvider(
        [{ success: true, data: { reference: "airtel-should-not-be-called" } }],
        [],
        "airtel",
      );

      const service = new MobileMoneyService(
        new Map([
          ["mtn", mtn],
          ["airtel", airtel],
        ]) as any,
      );

      await expect(
        service.initiatePayment("mtn", "+111111111", "100"),
      ).rejects.toThrow(/provider.*failed/);

      // Only mtn should have been called (no failover)
      expect(mtn.requestPaymentCalls).toBe(1);
      expect(airtel.requestPaymentCalls).toBe(0);
    });

    it("handles empty chain gracefully (no failover configured)", async () => {
      delete process.env.PROVIDER_BACKUP_MTN;
      delete process.env.PROVIDER_FAILOVER_CHAIN_MTN;

      const mtn = new FakeProvider(
        [
          {
            success: false,
            error: new Error("timeout mtn"),
          },
        ],
        [],
        "mtn",
      );

      const service = new MobileMoneyService(
        new Map([["mtn", mtn]]) as any,
      );

      await expect(
        service.initiatePayment("mtn", "+111111111", "100"),
      ).rejects.toThrow(/provider.*failed/);

      expect(mtn.requestPaymentCalls).toBe(1);
    });

    it("continues chain through circuit breaker open state", async () => {
      delete process.env.PROVIDER_BACKUP_MTN;
      process.env.PROVIDER_FAILOVER_CHAIN_MTN = "airtel,orange";

      const mtn = new FakeProvider(
        [
          { success: false, error: new Error("timeout mtn-1") },
          { success: false, error: new Error("timeout mtn-2") },
          { success: false, error: new Error("timeout mtn-3") },
        ],
        [],
        "mtn",
      );
      const airtel = new FakeProvider(
        [
          { success: false, error: new Error("timeout airtel-1") },
          { success: false, error: new Error("timeout airtel-2") },
          { success: false, error: new Error("timeout airtel-3") },
        ],
        [],
        "airtel",
      );
      const orange = new FakeProvider(
        [
          { success: true },
        ],
        [],
        "orange",
      );

      const service = new MobileMoneyService(
        new Map([
          ["mtn", mtn],
          ["airtel", airtel],
          ["orange", orange],
        ]) as any,
      );

      // Fire multiple requests to open the circuit breakers for both mtn and airtel
      await service.initiatePayment("mtn", "+1", "10").catch(() => {});
      await service.initiatePayment("mtn", "+2", "10").catch(() => {});
      await service.initiatePayment("mtn", "+3", "10").catch(() => {});

      // Fourth request: mtn circuit is open → should fail to airtel
      // Airtel circuit is also open → should fail to orange
      const result = await service.initiatePayment("mtn", "+4", "10");

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("reference");
      expect(result.success).toBe(true);
      // mtn and airtel each had 3 calls (circuit opened after 3rd); 4th request immediately fails over
      expect(mtn.requestPaymentCalls).toBe(3);
      expect(airtel.requestPaymentCalls).toBe(3);
      // orange was called for each of the 3 failed cascades + the final successful request
      expect(orange.requestPaymentCalls).toBe(4);
    });
  });

  // ── Payout failover ─────────────────────────────────────────────────

  describe("sendPayout failover", () => {
    it("fails over on payout transient errors", async () => {
      const providers = new Map();
      providers.set(
        "mtn",
        new FakeProvider(
          [{ success: false, error: new Error("timeout mtn-payout") }],
          [{ success: false, error: new Error("timeout mtn-payout") }],
          "mtn",
        ),
      );
      providers.set(
        "airtel",
        new FakeProvider(
          [],
          [{ success: true, data: { reference: "airtel-payout" } }],
          "airtel",
        ),
      );

      const service = new MobileMoneyService(providers as any);
      const result = await service.sendPayout("mtn", "+222222222", "200");

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ reference: "airtel-payout" });
    });
  });
});
