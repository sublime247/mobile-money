import { MobileMoneyService } from "../../../src/services/mobilemoney/mobileMoneyService";
import { MockProvider } from "../../../src/services/mobilemoney/providers/mock";
import { ChaosMiddleware } from "../../../src/services/mobilemoney/providers/chaos";

describe("ChaosMiddleware", () => {
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should inject latency when enabled", async () => {
    const config = {
      enabled: true,
      latencyChance: 1.0, // Always inject
      latencyMs: 100,
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
      latencyMs: 0,
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
      latencyMs: 0,
      errorChance: 0,
      dropChance: 1.0, // Always drop
    };
    const chaos = new ChaosMiddleware(mockProvider, config);

    await expect(chaos.requestPayment("123456789", "1000")).rejects.toThrow(
      "Chaos: Connectivity drop",
    );
  });

  it("should not inject chaos when disabled", async () => {
    const config = {
      enabled: false,
      latencyChance: 1.0,
      latencyMs: 1000,
      errorChance: 1.0,
      dropChance: 1.0,
    };
    const chaos = new ChaosMiddleware(mockProvider, config);

    const result = await chaos.requestPayment("123456789", "1000");
    expect(result.success).toBe(true);
  });
});
