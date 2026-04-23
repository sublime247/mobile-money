/**
 * tests/jobs/providerHealthCheck.test.ts
 *
 * Tests for the automated provider health check job
 */

import { runProviderHealthCheckJob } from "../../src/jobs/providerHealthCheck";
import * as healthCheckModule from "../../src/services/mobilemoney/providers/healthCheck";

// Mock the health check module
jest.mock("../../src/services/mobilemoney/providers/healthCheck");

// Mock global fetch
global.fetch = jest.fn() as jest.Mock;

describe("runProviderHealthCheckJob", () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    delete process.env.PROVIDER_HEALTH_WEBHOOK_URL;
    delete process.env.SLACK_ALERTS_WEBHOOK_URL;
    delete process.env.PAGERDUTY_WEBHOOK_URL;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("should complete successfully when all providers are up", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "up" as const, responseTime: 150 },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    await runProviderHealthCheckJob();

    expect(healthCheckModule.checkMobileMoneyHealth).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[provider-health] Starting provider health check"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[provider-health] Health check completed - 0 provider(s) down"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[provider-health] All providers are operational"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should send alert when one provider is down", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    process.env.PROVIDER_HEALTH_WEBHOOK_URL = "https://webhook.example.com/alert";

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    await runProviderHealthCheckJob();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://webhook.example.com/alert",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining('"alertType":"provider_health_status"'),
      })
    );

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);

    expect(payload.severity).toBe("warning");
    expect(payload.downProviders).toEqual(["mtn"]);
    expect(payload.allProviders.mtn.status).toBe("down");
    expect(payload.allProviders.airtel.status).toBe("up");
    expect(payload.allProviders.orange.status).toBe("up");
  });

  it("should send critical alert when multiple providers are down", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "down" as const, responseTime: null },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    process.env.SLACK_ALERTS_WEBHOOK_URL = "https://slack.example.com/webhook";

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    await runProviderHealthCheckJob();

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);

    expect(payload.severity).toBe("critical");
    expect(payload.downProviders).toEqual(["mtn", "airtel"]);
  });

  it("should send alerts to multiple webhook URLs", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    process.env.PROVIDER_HEALTH_WEBHOOK_URL = "https://webhook1.example.com";
    process.env.SLACK_ALERTS_WEBHOOK_URL = "https://webhook2.example.com";
    process.env.PAGERDUTY_WEBHOOK_URL = "https://webhook3.example.com";

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    await runProviderHealthCheckJob();

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://webhook1.example.com",
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://webhook2.example.com",
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://webhook3.example.com",
      expect.any(Object)
    );
  });

  it("should warn when providers are down but no webhook is configured", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    await runProviderHealthCheckJob();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[provider-health] Provider outage detected but no alert webhook URL is configured"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should handle webhook failure gracefully", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    process.env.PROVIDER_HEALTH_WEBHOOK_URL = "https://webhook.example.com/alert";

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
    });

    await runProviderHealthCheckJob();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[provider-health] Failed to send alert")
    );
  });

  it("should handle health check failure", async () => {
    jest
      .spyOn(healthCheckModule, "checkMobileMoneyHealth")
      .mockRejectedValue(new Error("Network timeout"));

    await expect(runProviderHealthCheckJob()).rejects.toThrow("Network timeout");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[provider-health] Job failed: Network timeout"
    );
  });

  it("should deduplicate webhook URLs", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 200 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    // Set same URL for multiple env vars
    process.env.PROVIDER_HEALTH_WEBHOOK_URL = "https://webhook.example.com";
    process.env.SLACK_ALERTS_WEBHOOK_URL = "https://webhook.example.com";

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    await runProviderHealthCheckJob();

    // Should only call once due to deduplication
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("should include response times in alert payload", async () => {
    const mockHealthResult = {
      providers: {
        mtn: { status: "down" as const, responseTime: null },
        airtel: { status: "up" as const, responseTime: 250 },
        orange: { status: "up" as const, responseTime: 180 },
      },
    };

    jest.spyOn(healthCheckModule, "checkMobileMoneyHealth").mockResolvedValue(mockHealthResult);

    process.env.PROVIDER_HEALTH_WEBHOOK_URL = "https://webhook.example.com/alert";

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    await runProviderHealthCheckJob();

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);

    expect(payload.allProviders.mtn.responseTime).toBeNull();
    expect(payload.allProviders.airtel.responseTime).toBe(250);
    expect(payload.allProviders.orange.responseTime).toBe(180);
  });
});
