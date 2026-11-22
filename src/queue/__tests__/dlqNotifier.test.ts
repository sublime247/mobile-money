/**
 * src/queue/__tests__/dlqNotifier.test.ts (#2374)
 *
 * Verifies that a job which has exhausted all retry attempts dispatches a
 * formatted DLQ alert (job id, transaction reference, error stack, retry
 * count) via the existing retryable Slack/Discord webhook client
 * (src/services/alertService.ts), and that an in-progress retry (not yet at
 * its final attempt) does NOT trigger a notification.
 */

const mockSendAlert = jest.fn();

jest.mock("../../services/alertService", () => ({
  sendAlert: (...args: unknown[]) => mockSendAlert(...args),
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { notifyDlqRetryLimitExceeded, isFinalAttempt } from "../dlqNotifier";
import logger from "../../utils/logger";

function makeJob(
  overrides: Partial<{
    id: string;
    attemptsMade: number;
    attempts: number;
    data: Record<string, unknown>;
    queueName: string;
  }> = {},
) {
  return {
    id: overrides.id ?? "job-123",
    attemptsMade: overrides.attemptsMade ?? 5,
    opts: { attempts: overrides.attempts ?? 5 },
    data: overrides.data ?? { transactionId: "txn-abc" },
    queueName: overrides.queueName ?? "webhook-callback-retries",
  } as any;
}

describe("isFinalAttempt", () => {
  it("is true once attemptsMade reaches the job's configured max attempts", () => {
    expect(isFinalAttempt(makeJob({ attemptsMade: 5, attempts: 5 }))).toBe(
      true,
    );
  });

  it("is false while retries remain", () => {
    expect(isFinalAttempt(makeJob({ attemptsMade: 2, attempts: 5 }))).toBe(
      false,
    );
  });
});

describe("notifyDlqRetryLimitExceeded", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("dispatches a critical alert with job id, transaction reference, retry count, and error stack on final failure", async () => {
    mockSendAlert.mockResolvedValueOnce({
      slack: "sent",
      discord: "skipped_no_url",
    });
    const job = makeJob({
      id: "job-999",
      attemptsMade: 5,
      attempts: 5,
      data: { transactionId: "txn-xyz" },
      queueName: "webhook-callback-retries",
    });
    const error = new Error("Webhook endpoint returned 500");
    error.stack =
      "Error: Webhook endpoint returned 500\n    at foo (bar.ts:1:1)";

    await notifyDlqRetryLimitExceeded(job, error, {
      queueName: "webhook-callback-retries",
    });

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "webhook-callback-retries",
        severity: "critical",
        transactionId: "txn-xyz",
        error: expect.stringContaining("Webhook endpoint returned 500"),
        meta: expect.objectContaining({
          jobId: "job-999",
          queueName: "webhook-callback-retries",
          retryCount: 5,
          errorStack: expect.stringContaining("at foo (bar.ts:1:1)"),
        }),
      }),
    );
  });

  it("does NOT dispatch a notification when retries remain (not the final attempt)", async () => {
    const job = makeJob({ attemptsMade: 2, attempts: 5 });

    await notifyDlqRetryLimitExceeded(job, new Error("transient"), {
      queueName: "webhook-callback-retries",
    });

    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("is a no-op when no job is provided", async () => {
    await notifyDlqRetryLimitExceeded(undefined, new Error("n/a"), {
      queueName: "webhook-callback-retries",
    });

    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("falls back to the BullMQ job id as the transaction reference when no domain reference is present", async () => {
    mockSendAlert.mockResolvedValueOnce({
      slack: "sent",
      discord: "skipped_no_url",
    });
    const job = makeJob({ id: "job-555", data: {} });

    await notifyDlqRetryLimitExceeded(job, new Error("boom"), {
      queueName: "account-merge",
    });

    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "job-555" }),
    );
  });

  it("truncates very long error stacks instead of sending them unbounded", async () => {
    mockSendAlert.mockResolvedValueOnce({
      slack: "sent",
      discord: "skipped_no_url",
    });
    const job = makeJob();
    const error = new Error("boom");
    error.stack = "x".repeat(5000);

    await notifyDlqRetryLimitExceeded(job, error, {
      queueName: "webhook-callback-retries",
    });

    const sentMeta = mockSendAlert.mock.calls[0][0].meta;
    expect(sentMeta.errorStack.length).toBeLessThan(1600);
    expect(sentMeta.errorStack).toContain("(truncated)");
  });

  it("logs and swallows errors from the notification dispatch itself, never throwing", async () => {
    mockSendAlert.mockRejectedValueOnce(new Error("webhook delivery failed"));
    const job = makeJob();

    await expect(
      notifyDlqRetryLimitExceeded(job, new Error("original failure"), {
        queueName: "webhook-callback-retries",
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
