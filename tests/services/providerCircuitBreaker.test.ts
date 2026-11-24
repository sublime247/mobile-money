import {
  getProviderCircuitState,
  isProviderCircuitOpen,
  buildProviderCircuitOpenResponse,
} from "../../src/services/providerCircuitBreaker";
import {
  executeWithCircuitBreaker,
  resetCircuitBreakers,
} from "../../src/utils/circuitBreaker";

jest.mock("../../src/utils/metrics", () => ({
  providerCircuitBreakerState: { set: jest.fn() },
  providerCircuitBreakerTransitionsTotal: { inc: jest.fn() },
}));

jest.mock("../../src/services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));

// Avoid a real DB round-trip from getBreakerOptions() -> getProviderSettings():
// the test environment has no live Postgres, so an unmocked call here hangs
// on the connection attempt rather than failing fast (a pre-existing gap in
// tests/jest.setup.ts, which mocks redis/ioredis but not the DB pool).
jest.mock("../../src/services/providerSettingsService", () => ({
  providerSettingsService: {
    getProviderSettings: jest.fn().mockResolvedValue(null),
    resolveMaintenanceRouting: jest
      .fn()
      .mockResolvedValue({ action: "proceed" }),
  },
}));

describe("providerCircuitBreaker facade (#1962)", () => {
  const provider = "facade-test-provider-" + Date.now();

  beforeEach(() => {
    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "2";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "50";
    process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS = "50";
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "1000000";
    resetCircuitBreakers();
  });

  afterAll(() => {
    resetCircuitBreakers();
  });

  it("reports CLOSED for a provider with no recorded calls yet", () => {
    const untouchedProvider = "never-called-" + Date.now();
    expect(getProviderCircuitState(untouchedProvider)).toBe("CLOSED");
    expect(isProviderCircuitOpen(untouchedProvider)).toBe(false);
  });

  it("reports OPEN once enough failures trip the underlying breaker", async () => {
    for (let i = 0; i < 3; i++) {
      await executeWithCircuitBreaker({
        provider,
        operation: "requestPayment",
        execute: async () => ({ success: false, error: new Error("boom") }),
      }).catch(() => undefined);
    }

    expect(getProviderCircuitState(provider, "requestPayment")).toBe("OPEN");
    expect(isProviderCircuitOpen(provider, "requestPayment")).toBe(true);
  });

  it("builds a friendly PROVIDER_CIRCUIT_OPEN response shape", () => {
    const response = buildProviderCircuitOpenResponse("mtn", "sendPayout");
    expect(response.success).toBe(false);
    expect(response.provider).toBe("mtn");
    expect(response.error).toMatchObject({
      code: "PROVIDER_CIRCUIT_OPEN",
      provider: "mtn",
      operation: "sendPayout",
    });
    expect(response.error.message).toMatch(/temporarily unavailable/i);
  });

  it("defaults the operation to requestPayment when not specified", () => {
    const response = buildProviderCircuitOpenResponse("airtel");
    expect(response.error.operation).toBe("requestPayment");
  });
});
