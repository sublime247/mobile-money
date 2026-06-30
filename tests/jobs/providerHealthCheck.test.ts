/**
 * tests/jobs/providerHealthCheck.test.ts
 *
 * Tests for the automated provider health check job
 */

import * as healthCheckModule from "../../src/services/mobilemoney/providers/healthCheck";
import * as cbModule from "../../src/utils/circuitBreaker";

// Mock the dependencies
jest.mock("../../src/services/mobilemoney/providers/healthCheck");
jest.mock("../../src/utils/circuitBreaker");

// Mock global fetch
global.fetch = jest.fn() as jest.Mock;

describe("runProviderHealthCheckJob", () => {
  let runProviderHealthCheckJob: any;
  let _resetActiveIncidents: any;
  let getActiveIncidents: any;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.PAGERDUTY_INTEGRATION_KEY = "test-pd-key";
    process.env.PAGERDUTY_DEDUP_KEY = "test-dedup";
    
    // Import dynamically after env vars are set
    const mod = require("../../src/jobs/providerHealthCheck");
    runProviderHealthCheckJob = mod.runProviderHealthCheckJob;
    _resetActiveIncidents = mod._resetActiveIncidents;
    getActiveIncidents = mod.getActiveIncidents;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetActiveIncidents();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    delete process.env.PAGERDUTY_INTEGRATION_KEY;
    delete process.env.PAGERDUTY_DEDUP_KEY;
  });

  it("should complete successfully when all providers are up and attempt circuit breaker resets", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "up" as const, responseTime: 150 },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest
      .spyOn(healthCheckModule, "checkMobileMoneyHealth")
      .mockResolvedValue(mockHealthResult);

    const resetSpy = jest.spyOn(cbModule, "checkAndResetCircuitBreaker").mockResolvedValue(true);

    await runProviderHealthCheckJob();

    expect(healthCheckModule.checkMobileMoneyHealth).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(6); // 3 providers * 2 operations (requestPayment, sendPayout)
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getActiveIncidents().size).toBe(0);
  });

  it("should trigger PagerDuty outage incident when a provider is down", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest
      .spyOn(healthCheckModule, "checkMobileMoneyHealth")
      .mockResolvedValue(mockHealthResult);

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(""),
    });

    await runProviderHealthCheckJob();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://events.pagerduty.com/v2/enqueue",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("test-pd-key"),
      }),
    );

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);
    expect(payload.event_action).toBe("trigger");
    expect(payload.dedup_key).toBe("test-dedup-mtn-outage");

    expect(getActiveIncidents().has("mtn")).toBe(true);
  });

  it("should resolve PagerDuty outage incident when provider recovers", async () => {
    // 1. First run: provider is down
    const mockHealthResultDown = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest
      .spyOn(healthCheckModule, "checkMobileMoneyHealth")
      .mockResolvedValueOnce(mockHealthResultDown);

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(""),
    });

    await runProviderHealthCheckJob();
    expect(getActiveIncidents().has("mtn")).toBe(true);

    // 2. Second run: provider recovers (is up)
    const mockHealthResultUp = {
      providers: {
        mtn: { status: "up" as const, responseTime: 120 },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest
      .spyOn(healthCheckModule, "checkMobileMoneyHealth")
      .mockResolvedValueOnce(mockHealthResultUp);

    await runProviderHealthCheckJob();

    // Should have called fetch again to resolve the incident
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const callArgs = (global.fetch as jest.Mock).mock.calls[1];
    const payload = JSON.parse(callArgs[1].body);
    expect(payload.event_action).toBe("resolve");
    expect(payload.dedup_key).toBe("test-dedup-mtn-outage");

    expect(getActiveIncidents().has("mtn")).toBe(false);
  });

  it("should handle health check failure by throwing", async () => {
    jest
      .spyOn(healthCheckModule, "checkMobileMoneyHealth")
      .mockRejectedValue(new Error("Network timeout"));

    await expect(runProviderHealthCheckJob()).rejects.toThrow("Network timeout");
  });
});
