import { redisClient } from "../../config/redis";
import { providerHttp, recordProviderAuthStatus } from "../providerStatus";

jest.mock("../../config/redis", () => ({
  redisClient: { isReady: true, incr: jest.fn(), eval: jest.fn() },
}));

import axios from "axios";
import { sendAlert, sendLowBalanceAlert, resetAlertRateLimits } from "../alertService";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("alertService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetAlertRateLimits();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("sendAlert", () => {
    test("skips both channels when neither webhook URL is configured", async () => {
      delete process.env.SLACK_ALERT_WEBHOOK_URL;
      delete process.env.DISCORD_ALERT_WEBHOOK_URL;

      const result = await sendAlert({ provider: "airtel", error: "Timeout" });

      expect(result).toEqual({ slack: "skipped_no_url", discord: "skipped_no_url" });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    test("sends to Slack only when only SLACK_ALERT_WEBHOOK_URL is set", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      delete process.env.DISCORD_ALERT_WEBHOOK_URL;
      mockedAxios.post.mockResolvedValue({ status: 200 });

      const result = await sendAlert({ provider: "mtn", error: "Connection refused" });

      expect(result).toEqual({ slack: "sent", discord: "skipped_no_url" });
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/test",
        expect.objectContaining({ text: expect.stringContaining("mtn") }),
        expect.any(Object),
      );
    });

    test("sends to both channels when both webhook URLs are configured", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      process.env.DISCORD_ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      const result = await sendAlert({ provider: "orange", error: "503 Service Unavailable" });

      expect(result).toEqual({ slack: "sent", discord: "sent" });
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    test("includes transaction ID, provider, error, and timestamp in the Slack payload", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendAlert({
        provider: "vodacom",
        error: "Upstream 500",
        transactionId: "tx-999",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const [, payload] = mockedAxios.post.mock.calls[0];
      const fieldsText = JSON.stringify(payload);
      expect(fieldsText).toContain("vodacom");
      expect(fieldsText).toContain("Upstream 500");
      expect(fieldsText).toContain("tx-999");
      expect(fieldsText).toContain("2026-01-01T00:00:00.000Z");
    });

    test("includes transaction ID, provider, error, and timestamp in the Discord payload", async () => {
      process.env.DISCORD_ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendAlert({
        provider: "vodacom",
        error: "Upstream 500",
        transactionId: "tx-999",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const [, payload] = mockedAxios.post.mock.calls[0];
      const fieldsText = JSON.stringify(payload);
      expect(fieldsText).toContain("vodacom");
      expect(fieldsText).toContain("Upstream 500");
      expect(fieldsText).toContain("tx-999");
      expect(fieldsText).toContain("2026-01-01T00:00:00.000Z");
    });

    test("rate-limits repeated alerts for the same provider within the cooldown window", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      const first = await sendAlert({ provider: "mtn", error: "err 1" });
      const second = await sendAlert({ provider: "mtn", error: "err 2" });

      expect(first.slack).toBe("sent");
      expect(second.slack).toBe("skipped_rate_limited");
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    test("does not rate-limit a different provider during another provider's cooldown", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendAlert({ provider: "mtn", error: "err" });
      const result = await sendAlert({ provider: "airtel", error: "err" });

      expect(result.slack).toBe("sent");
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    test("allows a new alert for the same provider once the cooldown has elapsed", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      const first = await sendAlert({ provider: "mtn", error: "err 1" }, { cooldownMs: 10 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await sendAlert({ provider: "mtn", error: "err 2" }, { cooldownMs: 10 });

      expect(first.slack).toBe("sent");
      expect(second.slack).toBe("sent");
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    test("reports 'failed' for a channel whose webhook request throws, without throwing itself", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockRejectedValue(new Error("network error"));

      const result = await sendAlert({ provider: "mtn", error: "err" });

      expect(result.slack).toBe("failed");
    });

    test("one channel failing does not prevent the other from sending", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      process.env.DISCORD_ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
      mockedAxios.post.mockImplementation((url: string) => {
        if (url.includes("slack")) return Promise.reject(new Error("slack down"));
        return Promise.resolve({ status: 200 });
      });

      const result = await sendAlert({ provider: "mtn", error: "err" });

      expect(result.slack).toBe("failed");
      expect(result.discord).toBe("sent");
    });
  });

  describe("sendLowBalanceAlert", () => {
    test("classifies a small shortfall as a warning", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendLowBalanceAlert({
        provider: "mtn",
        currentBalance: 950,
        threshold: 1000,
        currency: "GHS",
      });

      const [, payload] = mockedAxios.post.mock.calls[0];
      expect(JSON.stringify(payload)).toContain("⚠️");
    });

    test("classifies a severe shortfall as critical", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendLowBalanceAlert({
        provider: "mtn",
        currentBalance: 100,
        threshold: 1000,
        currency: "GHS",
      });

      const [, payload] = mockedAxios.post.mock.calls[0];
      expect(JSON.stringify(payload)).toContain("🚨");
    });

    test("includes balance, threshold, and currency in the alert", async () => {
      process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendLowBalanceAlert({
        provider: "airtel",
        currentBalance: 200,
        threshold: 1000,
        currency: "UGX",
      });

      const [, payload] = mockedAxios.post.mock.calls[0];
      const text = JSON.stringify(payload);
      expect(text).toContain("200");
      expect(text).toContain("1000");
      expect(text).toContain("UGX");
    });
  });
});

describe("consecutive provider authentication failures", () => {
  const counts = new Map<string, number>();
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    counts.clear();
    process.env = {
      ...originalEnv,
      SLACK_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/test",
      DISCORD_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    };
    mockedAxios.post.mockResolvedValue({ status: 200 });
    jest.mocked(redisClient.incr).mockImplementation(async (key: string) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count;
    });
    jest.mocked(redisClient.eval).mockImplementation(async (_script, options) => {
      const key = options?.keys?.[0];
      return key && counts.delete(key) ? 1 : 0;
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("sends one Slack alert on the third 401/403 for a provider", async () => {
    await recordProviderAuthStatus("mtn", 401);
    await recordProviderAuthStatus("orange", 403);
    await recordProviderAuthStatus("mtn", 403);
    expect(mockedAxios.post).not.toHaveBeenCalled();

    await Promise.all([
      recordProviderAuthStatus("mtn", 401),
      recordProviderAuthStatus("mtn", 403),
    ]);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      process.env.SLACK_ALERT_WEBHOOK_URL,
      expect.objectContaining({ text: expect.stringContaining("mtn") }),
      expect.any(Object),
    );
  });

  it("resets on success and immediately alerts for a new streak", async () => {
    for (const status of [401, 403, 200, 401, 401]) {
      await recordProviderAuthStatus("airtel", status);
    }
    expect(mockedAxios.post).not.toHaveBeenCalled();

    for (const status of [403, 204, 403, 403, 401]) {
      await recordProviderAuthStatus("airtel", status);
    }
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it("observes both Axios responses and rejected HTTP errors", async () => {
    const error = { response: { status: 401 } };
    mockedAxios.get
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 403 })
      .mockRejectedValueOnce(error);
    const client = providerHttp("mpesa");

    await expect(client.get("/test")).rejects.toBe(error);
    await expect(client.get("/test")).resolves.toEqual({ status: 403 });
    await expect(client.get("/test")).rejects.toBe(error);
    await Promise.resolve();

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
