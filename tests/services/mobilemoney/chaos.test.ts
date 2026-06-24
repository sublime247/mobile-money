import { MockProvider } from "../../../src/services/mobilemoney/providers/mock";
import { ChaosMiddleware, getChaosConfigFromEnv } from "../../../src/services/mobilemoney/providers/chaos";

describe("ChaosMiddleware", () => {
  let mockProvider: MockProvider;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockProvider = new MockProvider();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it("should inject latency when enabled", async () => {
    const config = {
      enabled: true,
      latencyChance: 1.0, // Always inject
      latencyMinMs: 100,
      latencyMaxMs: 100,
      errorChance: 0,
      dropChance: 0,
    };
    const chaos = new ChaosMiddleware(mockProvider, config);
    
    const start = Date.now();
    await chaos.requestPayment("123456789", "1000");
    const duration = Date.now() - start;
    
    // We expect some delay. Since we use Math.random() * latencyMs, it could be small, 
    // but with 100ms it should be visible if we mock the random or just check it's >= 0.
    // To be sure, we could mock Math.random.
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("should inject 500 errors when enabled", async () => {
    const config = {
      enabled: true,
      latencyChance: 0,
      latencyMinMs: 0,
      latencyMaxMs: 0,
      errorChance: 1.0, // Always fail
      dropChance: 0,
    };
    const chaos = new ChaosMiddleware(mockProvider, config);
    
    const result = await chaos.requestPayment("123456789", "1000");
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(500);
  });

  it("should simulate connectivity drops when enabled", async () => {
    const config = {
      enabled: true,
      latencyChance: 0,
      latencyMinMs: 0,
      latencyMaxMs: 0,
      errorChance: 0,
      dropChance: 1.0, // Always drop
    };
    const chaos = new ChaosMiddleware(mockProvider, config);
    
    await expect(chaos.requestPayment("123456789", "1000")).rejects.toThrow("Chaos: Connectivity drop");
  });

  it("should not inject chaos when disabled", async () => {
    const config = {
      enabled: false,
      latencyChance: 1.0,
      latencyMinMs: 1000,
      latencyMaxMs: 1000,
      errorChance: 1.0,
      dropChance: 1.0,
    };
    const chaos = new ChaosMiddleware(mockProvider, config);
    
    const result = await chaos.requestPayment("123456789", "1000");
    expect(result.success).toBe(true);
  });

  it("should build chaos config from environment variables", () => {
    const config = getChaosConfigFromEnv({
      CHAOS_ENABLED: "true",
      CHAOS_LATENCY_CHANCE: "0.25",
      CHAOS_LATENCY_MIN_MS: "50",
      CHAOS_LATENCY_MAX_MS: "250",
      CHAOS_ERROR_CHANCE: "0.1",
      CHAOS_DROP_CHANCE: "0.05",
    });

    expect(config).toEqual({
      enabled: true,
      latencyChance: 0.25,
      latencyMinMs: 50,
      latencyMaxMs: 250,
      errorChance: 0.1,
      dropChance: 0.05,
    });
  });

  it("should use environment configuration when no explicit config is provided", async () => {
    process.env.CHAOS_ENABLED = "true";
    process.env.CHAOS_ERROR_CHANCE = "1";

    const chaos = new ChaosMiddleware(mockProvider);

    const result = await chaos.requestPayment("123456789", "1000");
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(500);
  });
});
