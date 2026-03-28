jest.mock("../../src/utils/metrics", () => ({
  providerCircuitBreakerState: {
    set: jest.fn(),
  },
  providerCircuitBreakerTransitionsTotal: {
    inc: jest.fn(),
  },
}));

import {
  executeWithCircuitBreaker,
  getCircuitBreakerCount,
  resetCircuitBreakers,
} from "../../src/utils/circuitBreaker";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "../../src/utils/metrics";

describe("executeWithCircuitBreaker", () => {
  beforeEach(() => {
    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "25";
    resetCircuitBreakers();
    jest.clearAllMocks();
  });

  afterEach(() => {
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
});
