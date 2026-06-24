jest.mock("../../src/utils/metrics", () => ({
  providerCircuitBreakerState: {
    set: jest.fn(),
  },
  providerCircuitBreakerTransitionsTotal: {
    inc: jest.fn(),
  },
}));

jest.mock("../../src/services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));

import {
  executeWithCircuitBreaker,
  getCircuitBreakerCount,
  resetCircuitBreakers,
  checkAndResetCircuitBreaker,
  _resolveFailureThreshold,
  _resolveTimeoutMs,
} from "../../src/utils/circuitBreaker";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "../../src/utils/metrics";
import { checkMobileMoneyHealth } from "../../src/services/mobilemoney/providers/healthCheck";

describe("executeWithCircuitBreaker", () => {
  beforeEach(() => {
    delete process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS;

    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "25";
    resetCircuitBreakers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS;
    resetCircuitBreakers();
  });

  it("emits metrics when the circuit transitions from open to half-open to closed", async () => {
    await expect(
      executeWithCircuitBreaker({
        provider: "mtn",
        operation: "requestPayment",
        execute: async () => ({
          success: false,
          error: new Error("provider-down"),
        }),
      }),
    ).rejects.toThrow("provider-down");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const result = await executeWithCircuitBreaker({
      provider: "mtn",
      operation: "requestPayment",
      execute: async () => ({
        success: true,
        data: { reference: "recovered" },
      }),
    });

    expect(result).toEqual({
      success: true,
      data: { reference: "recovered" },
    });
    expect(providerCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      operation: "requestPayment",
      state: "open",
    });
    expect(providerCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      operation: "requestPayment",
      state: "half_open",
    });
    expect(providerCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      operation: "requestPayment",
      state: "closed",
    });
    expect(providerCircuitBreakerState.set).toHaveBeenCalledWith(
      { provider: "mtn", operation: "requestPayment" },
      1,
    );
    expect(providerCircuitBreakerState.set).toHaveBeenCalledWith(
      { provider: "mtn", operation: "requestPayment" },
      0.5,
    );
    expect(providerCircuitBreakerState.set).toHaveBeenCalledWith(
      { provider: "mtn", operation: "requestPayment" },
      0,
    );
  });

  it("reuses the same breaker per provider and operation until reset", async () => {
    await executeWithCircuitBreaker({
      provider: "mtn",
      operation: "requestPayment",
      execute: async () => ({
        success: true,
        data: { reference: "one" },
      }),
    });
    await executeWithCircuitBreaker({
      provider: "mtn",
      operation: "requestPayment",
      execute: async () => ({
        success: true,
        data: { reference: "two" },
      }),
    });

    expect(getCircuitBreakerCount()).toBe(1);

    resetCircuitBreakers();

    expect(getCircuitBreakerCount()).toBe(0);
  });

  describe("per-provider failure threshold env vars", () => {
    beforeEach(() => {
      delete process.env.VODACOM_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
    });

    afterEach(() => {
      delete process.env.VODACOM_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
    });

    it("returns null when no env var is set", () => {
      expect(_resolveFailureThreshold("vodacom")).toBeNull();
    });

    it("uses provider-specific env var when set", () => {
      process.env.VODACOM_CIRCUIT_BREAKER_FAILURE_THRESHOLD = "10";
      expect(_resolveFailureThreshold("vodacom")).toBe(10);
    });

    it("falls back to global env var when provider-specific is not set", () => {
      process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "7";
      expect(_resolveFailureThreshold("vodacom")).toBe(7);
    });

    it("provider-specific takes precedence over global", () => {
      process.env.VODACOM_CIRCUIT_BREAKER_FAILURE_THRESHOLD = "5";
      process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "3";
      expect(_resolveFailureThreshold("vodacom")).toBe(5);
    });

    it("handles different providers independently", () => {
      process.env.MTN_CIRCUIT_BREAKER_FAILURE_THRESHOLD = "4";
      process.env.AIRTEL_CIRCUIT_BREAKER_FAILURE_THRESHOLD = "8";
      expect(_resolveFailureThreshold("mtn")).toBe(4);
      expect(_resolveFailureThreshold("airtel")).toBe(8);
      expect(_resolveFailureThreshold("vodacom")).toBeNull();
    });
  });

  describe("per-provider timeout env vars", () => {
    beforeEach(() => {
      delete process.env.VODACOM_CIRCUIT_BREAKER_TIMEOUT_MS;
      delete process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS;
    });

    it("returns null when no env var is set", () => {
      expect(_resolveTimeoutMs("vodacom")).toBeNull();
    });

    it("uses provider-specific timeout when set", () => {
      process.env.VODACOM_CIRCUIT_BREAKER_TIMEOUT_MS = "15000";
      expect(_resolveTimeoutMs("vodacom")).toBe(15000);
    });

    it("falls back to global timeout", () => {
      process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS = "10000";
      expect(_resolveTimeoutMs("vodacom")).toBe(10000);
    });
  });

  // checkAndResetCircuitBreaker tests are isolated in their own describe to avoid
  // test-interaction issues with opossum timer state leaking across tests.
  // When combined with other tests that manipulate the same circuit breaker
  // env vars, the opossum resetTimeout can fire before the health-check runs.
  describe("checkAndResetCircuitBreaker", () => {
    beforeEach(() => {
      // Ensure a clean env — the outer describe usually sets 25 ms which is too
      // short for this test sequence.
      delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
      delete process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE;
      delete process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;

      process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "1";
      process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "1";
      process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "5000";
      resetCircuitBreakers();
      jest.clearAllMocks();
    });

    it("resets open breaker when provider is healthy", async () => {
      // Use a unique key to guarantee a fresh breaker
      const testKey = "reset-test-" + process.pid;
      await expect(
        executeWithCircuitBreaker({
          provider: testKey,
          operation: "op",
          execute: async () => ({
            success: false,
            error: new Error("provider-down"),
          }),
        }),
      ).rejects.toThrow("provider-down");

      // Mock health check: return "up" for the test key
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
        providers: {
          [testKey]: { status: "up", responseTime: 100 },
        },
      });

      const reset = await checkAndResetCircuitBreaker(testKey, "op");
      expect(reset).toBe(true);
      expect(checkMobileMoneyHealth).toHaveBeenCalled();
    });

    it("does not reset if breaker is not open", async () => {
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
        providers: {
          mtn: { status: "up", responseTime: 100 },
        },
      });

      const reset = await checkAndResetCircuitBreaker("mtn", "requestPayment");
      expect(reset).toBe(false);
      expect(checkMobileMoneyHealth).not.toHaveBeenCalled();
    });

    it("does not reset if provider is down", async () => {
      // Use a unique key to guarantee a fresh breaker
      const testKey = "reset-down-" + process.pid;
      await expect(
        executeWithCircuitBreaker({
          provider: testKey,
          operation: "op",
          execute: async () => ({
            success: false,
            error: new Error("provider-down"),
          }),
        }),
      ).rejects.toThrow("provider-down");

      // Mock health check: return "down" for the test key
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
        providers: {
          [testKey]: { status: "down", responseTime: null },
        },
      });

      const reset = await checkAndResetCircuitBreaker(testKey, "op");
      expect(reset).toBe(false);
      expect(checkMobileMoneyHealth).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Targeted coverage for the (breaker as any).toJSON() cast on line 230
// ---------------------------------------------------------------------------
describe("checkAndResetCircuitBreaker — toJSON cast coverage", () => {
  beforeEach(() => {
    delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;

    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "1";
    // Long reset timeout so the breaker stays open for the duration of the test
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "5000";

    resetCircuitBreakers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE;
    delete process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
    resetCircuitBreakers();
  });

  it("invokes toJSON on the opossum breaker instance without throwing (cast is correct)", async () => {
    // Open the breaker so checkAndResetCircuitBreaker reaches the toJSON call
    const provider = "tojson-cast-provider-" + Date.now();

    await expect(
      executeWithCircuitBreaker({
        provider,
        operation: "op",
        execute: async () => ({ success: false, error: new Error("down") }),
      }),
    ).rejects.toThrow("down");

    // Simulate provider being healthy so the full code path through toJSON executes
    (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
      providers: { [provider]: { status: "up", responseTime: 50 } },
    });

    // Should not throw — if the cast were absent TS would still error at compile
    // time, but at runtime we verify the toJSON() call returns a usable object
    // with a `state` property that the surrounding code can read.
    const result = await checkAndResetCircuitBreaker(provider, "op");

    // The breaker was open so health check ran and closed the breaker → true
    expect(result).toBe(true);
    expect(checkMobileMoneyHealth).toHaveBeenCalledTimes(1);
  });

  it("returns false without calling toJSON when no breaker exists for the key", async () => {
    const result = await checkAndResetCircuitBreaker(
      "non-existent-provider",
      "non-existent-op",
    );

    // Guard clause returns early — toJSON is never reached
    expect(result).toBe(false);
    expect(checkMobileMoneyHealth).not.toHaveBeenCalled();
  });

  it("returns false without calling health check when breaker state is closed (not open/halfOpen)", async () => {
    // Register a breaker by running a successful execution first
    const provider = "closed-state-provider-" + Date.now();

    await executeWithCircuitBreaker({
      provider,
      operation: "op",
      execute: async () => ({ success: true, data: "ok" }),
    });

    // Breaker is closed — toJSON().state.open and .halfOpen are both falsy
    const result = await checkAndResetCircuitBreaker(provider, "op");

    expect(result).toBe(false);
    expect(checkMobileMoneyHealth).not.toHaveBeenCalled();
  });
});
