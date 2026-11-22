import axios from "axios";
import {
  dispatchWebhookBacklogAlert,
  resetAlertRateLimits,
  sendAlert,
  sendLowBalanceAlert,
  webhookBacklogAction,
} from "../alertService";

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

describe("webhook backlog alerts", () => {
  test.each([
    [500, 900, false, undefined],
    [501, 0, false, "trigger"],
    [1, 901, false, "trigger"],
    [1, 901, true, undefined],
    [100, 900, true, undefined],
    [99, 900, true, "resolve"],
    [501, 0, true, undefined],
    [0, 0, false, undefined],
  ])(
    "evaluates depth %i and age %i with an open incident of %s",
    (depth, oldestAgeSeconds, active, expected) => {
      expect(webhookBacklogAction({ depth, oldestAgeSeconds }, active)).toBe(
        expected,
      );
    },
  );

  it("uses one Events API v2 deduplication key for the trigger and resolve", async () => {
    mockedAxios.post.mockClear();
    const backlog = { depth: 501, oldestAgeSeconds: 15 };
    await dispatchWebhookBacklogAlert(
      "routing-key",
      "webhook-backlog",
      "trigger",
      backlog,
    );
    await dispatchWebhookBacklogAlert(
      "routing-key",
      "webhook-backlog",
      "resolve",
      backlog,
    );

    const event = { routing_key: "routing-key", dedup_key: "webhook-backlog" };
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      1,
      "https://events.pagerduty.com/v2/enqueue",
      expect.objectContaining({
        ...event,
        event_action: "trigger",
        payload: expect.objectContaining({
          severity: "critical",
          custom_details: backlog,
        }),
      }),
      { timeout: 5000, maxRedirects: 0 },
    );
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      2,
      "https://events.pagerduty.com/v2/enqueue",
      { ...event, event_action: "resolve" },
      { timeout: 5000, maxRedirects: 0 },
    );
  });
});
