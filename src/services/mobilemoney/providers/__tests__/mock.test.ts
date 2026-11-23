import { MockProvider } from "../mock";

describe("MockProvider (#2274)", () => {
  describe("default behavior (backward compatibility)", () => {
    it("succeeds synchronously with no configured delay or failure rate", async () => {
      const provider = new MockProvider();
      const result = await provider.requestPayment("+237670000000", "1000");

      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe("PENDING");
      expect((result.data as any).transactionId).toMatch(/^mock-pay-/);
    });

    it("sendPayout succeeds with SUCCESSFUL status by default", async () => {
      const provider = new MockProvider();
      const result = await provider.sendPayout("+237670000000", "1000");

      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe("SUCCESSFUL");
      expect((result.data as any).transactionId).toMatch(/^mock-payout-/);
    });
  });

  describe("configurable simulated delay", () => {
    it("waits at least the configured fixed delay before resolving", async () => {
      const provider = new MockProvider({ simulatedDelayMs: 50 });
      const start = Date.now();
      await provider.requestPayment("+237670000000", "1000");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // small tolerance for timer jitter
    });

    it("resolves immediately when delay is 0", async () => {
      const provider = new MockProvider({ simulatedDelayMs: 0 });
      const start = Date.now();
      await provider.requestPayment("+237670000000", "1000");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(20);
    });

    it("picks a delay within a configured [min, max] range using the injected RNG", async () => {
      const provider = new MockProvider({
        simulatedDelayMs: [100, 200],
        random: () => 0.5, // deterministic: picks the midpoint, 150ms
      });
      const start = Date.now();
      await provider.requestPayment("+237670000000", "1000");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(145);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe("configurable success/failure rate", () => {
    it("always fails when successRate is 0", async () => {
      const provider = new MockProvider({ successRate: 0 });
      const result = await provider.requestPayment("+237670000000", "1000");

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe("MOCK_PAYMENT_FAILED");
    });

    it("always succeeds when successRate is 1", async () => {
      const provider = new MockProvider({
        successRate: 1,
        random: () => 0.999999, // would fail any rate < 1
      });
      const result = await provider.requestPayment("+237670000000", "1000");
      expect(result.success).toBe(true);
    });

    it("respects a fractional success rate deterministically via the injected RNG", async () => {
      // successRate 0.5: rollSuccess() is `random() < 0.5`.
      const alwaysBelowHalf = new MockProvider({
        successRate: 0.5,
        random: () => 0.1,
      });
      expect(
        (await alwaysBelowHalf.requestPayment("+237670000000", "1000"))
          .success,
      ).toBe(true);

      const alwaysAboveHalf = new MockProvider({
        successRate: 0.5,
        random: () => 0.9,
      });
      expect(
        (await alwaysAboveHalf.requestPayment("+237670000000", "1000"))
          .success,
      ).toBe(false);
    });

    it("clamps out-of-range success rates into [0, 1]", async () => {
      const over = new MockProvider({ successRate: 5, random: () => 0.999 });
      expect(
        (await over.requestPayment("+237670000000", "1000")).success,
      ).toBe(true);

      const under = new MockProvider({
        successRate: -5,
        random: () => 0.0001,
      });
      expect(
        (await under.requestPayment("+237670000000", "1000")).success,
      ).toBe(false);
    });

    it("sendPayout also fails when successRate is 0", async () => {
      const provider = new MockProvider({ successRate: 0 });
      const result = await provider.sendPayout("+237670000000", "1000");

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe("MOCK_PAYOUT_FAILED");
    });
  });

  describe("mock webhook callback simulation", () => {
    it("invokes the webhook callback with the payment outcome after requestPayment settles", async () => {
      const callback = jest.fn();
      const provider = new MockProvider({ onWebhookCallback: callback });

      const result = await provider.requestPayment(
        "+237670000000",
        "1500",
        "req-1",
      );

      // Fire-and-forget: let the microtask queue flush before asserting.
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        transactionId: (result.data as any).transactionId,
        operation: "requestPayment",
        status: "SUCCESSFUL",
        phoneNumber: "+237670000000",
        amount: "1500",
      });
    });

    it("invokes the webhook callback with a FAILED status when the simulated call fails", async () => {
      const callback = jest.fn();
      const provider = new MockProvider({
        onWebhookCallback: callback,
        successRate: 0,
      });

      await provider.sendPayout("+237670000000", "2000");
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "sendPayout", status: "FAILED" }),
      );
    });

    it("does not reject or throw from the initiating call when the webhook callback itself throws", async () => {
      const throwingCallback = jest.fn(() => {
        throw new Error("simulated webhook consumer crash");
      });
      const provider = new MockProvider({ onWebhookCallback: throwingCallback });

      await expect(
        provider.requestPayment("+237670000000", "1000"),
      ).resolves.toMatchObject({ success: true });

      await new Promise((resolve) => setImmediate(resolve));
      expect(throwingCallback).toHaveBeenCalledTimes(1);
    });

    it("does not invoke the callback when none is configured", async () => {
      const provider = new MockProvider();
      await expect(
        provider.requestPayment("+237670000000", "1000"),
      ).resolves.toMatchObject({ success: true });
      // No assertion needed beyond "did not throw" - absence of a callback
      // must be a no-op, not an error.
    });
  });

  describe("getTransactionStatus", () => {
    it("always reports completed", async () => {
      const provider = new MockProvider();
      const status = await provider.getTransactionStatus("some-ref");
      expect(status).toEqual({ status: "completed" });
    });
  });
});
