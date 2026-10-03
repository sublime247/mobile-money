import { createHmac } from "crypto";
import { EventEmitter } from "events";

const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn();
const mockWorkerClose = jest.fn();
let registeredWorkerProcessor: any = null;
let registeredWorkerOptions: any = null;

jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation((name, opts) => ({
      name,
      opts,
      add: mockQueueAdd,
      close: mockQueueClose,
    })),
    Worker: jest.fn().mockImplementation((name, processor, opts) => {
      registeredWorkerProcessor = processor;
      registeredWorkerOptions = opts;
      return {
        name,
        on: jest.fn(),
        close: mockWorkerClose,
      };
    }),
  };
});

jest.mock("../../src/config/queue", () => ({
  handleFailedJob: jest.fn().mockResolvedValue({ id: "dlq-1", status: "failed" }),
}));

jest.mock("../../src/utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  CALLBACK_QUEUE_NAME,
  MAX_CALLBACK_ATTEMPTS,
  SEP24_CALLBACK_BACKOFF_SCHEDULE_MS,
  getCallbackBackoffDelay,
  enqueueCallbackRetry,
  deliverCallback,
  handleExhaustedCallback,
  registerSep24CallbackDispatcher,
  closeCallbackQueue,
} from "../../src/queue/callbackQueue";
import logger from "../../src/utils/logger";
import { handleFailedJob } from "../../src/config/queue";

describe("SEP-24 Interactive Transaction Callback Retry Queue (Issue 2124)", () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_WEBHOOK_SECRET = "test-stellar-secret";

    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    delete process.env.STELLAR_WEBHOOK_SECRET;
  });

  describe("1. Retry Backoff Schedule Calculation", () => {
    it("should match the exact 5-attempt schedule: 10s, 30s, 2m, 10m, 30m", () => {
      expect(SEP24_CALLBACK_BACKOFF_SCHEDULE_MS).toEqual([
        10_000, // 10s
        30_000, // 30s
        120_000, // 2m (120s)
        600_000, // 10m (600s)
        1_800_000, // 30m (1800s)
      ]);
    });

    it("should calculate delay accurately across all 5 retry attempts without jitter", () => {
      expect(getCallbackBackoffDelay(1)).toBe(10_000);
      expect(getCallbackBackoffDelay(2)).toBe(30_000);
      expect(getCallbackBackoffDelay(3)).toBe(120_000);
      expect(getCallbackBackoffDelay(4)).toBe(600_000);
      expect(getCallbackBackoffDelay(5)).toBe(1_800_000);
    });

    it("should clamp boundary values gracefully", () => {
      expect(getCallbackBackoffDelay(0)).toBe(10_000);
      expect(getCallbackBackoffDelay(-1)).toBe(10_000);
      expect(getCallbackBackoffDelay(6)).toBe(1_800_000);
      expect(getCallbackBackoffDelay(100)).toBe(1_800_000);
    });

    it("should apply bounded +/- 10% jitter when requested", () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const base = SEP24_CALLBACK_BACKOFF_SCHEDULE_MS[attempt - 1];
        const withJitter = getCallbackBackoffDelay(attempt, true);
        const minExpected = Math.round(base * 0.9);
        const maxExpected = Math.round(base * 1.1);

        expect(withJitter).toBeGreaterThanOrEqual(minExpected);
        expect(withJitter).toBeLessThanOrEqual(maxExpected);
      }
    });

    it("should evaluate worker backoffStrategy callback matching the schedule", () => {
      expect(registeredWorkerOptions?.settings?.backoffStrategy).toBeDefined();
      const strategy = registeredWorkerOptions.settings.backoffStrategy;

      expect(strategy(1)).toBe(10_000);
      expect(strategy(2)).toBe(30_000);
      expect(strategy(3)).toBe(120_000);
      expect(strategy(4)).toBe(600_000);
      expect(strategy(5)).toBe(1_800_000);
    });
  });

  describe("2. Enqueueing Callback Notifications", () => {
    it("should enqueue a callback job to BullMQ with max attempts and custom backoff", async () => {
      mockQueueAdd.mockResolvedValueOnce({ id: "job-sep24-1" });

      const jobData = {
        transactionId: "tx-test-99",
        status: "pending_user_transfer_start",
        callbackUrl: "https://wallet.example.com/api/sep24/callback",
        payload: { transaction_id: "tx-test-99", status: "pending_user_transfer_start" },
      };

      const result = await enqueueCallbackRetry(jobData);

      expect(result).toBeDefined();
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "deliver-callback",
        jobData,
        expect.objectContaining({
          attempts: MAX_CALLBACK_ATTEMPTS,
          backoff: {
            type: "custom",
          },
          removeOnFail: false,
        }),
      );
    });

    it("should skip enqueuing when callbackUrl is empty", async () => {
      const result = await enqueueCallbackRetry({
        transactionId: "tx-test-99",
        status: "completed",
        callbackUrl: "",
        payload: {},
      });

      expect(result).toBeNull();
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No callback URL provided"),
      );
    });

    it("should reject and skip enqueuing for SSRF blocked destinations", async () => {
      const blockedUrls = [
        "http://127.0.0.1:8080/cb",
        "http://169.254.169.254/metadata",
        "http://localhost:3000/cb",
      ];

      for (const url of blockedUrls) {
        const result = await enqueueCallbackRetry({
          transactionId: "tx-test-blocked",
          status: "completed",
          callbackUrl: url,
          payload: {},
        });

        expect(result).toBeNull();
      }

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("3. Callback HTTP Delivery", () => {
    it("should deliver payload with correct JSON body and X-Stellar-Signature HMAC", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue("OK"),
      });

      const payload = {
        transaction_id: "tx-456",
        status: "completed",
        amount_in: "100.00",
      };

      const result = await deliverCallback({
        transactionId: "tx-456",
        status: "completed",
        callbackUrl: "https://partner-wallet.org/notifications",
        payload,
      });

      expect(result).toEqual({ status: 200, body: "OK" });

      const expectedBody = JSON.stringify(payload);
      const expectedHmac =
        "sha256=" +
        createHmac("sha256", "test-stellar-secret")
          .update(expectedBody)
          .digest("hex");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://partner-wallet.org/notifications",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Stellar-Signature": expectedHmac,
          },
          body: expectedBody,
        },
      );
    });

    it("should throw an error when HTTP response is not ok", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: jest.fn().mockResolvedValue("Service Unavailable"),
      });

      await expect(
        deliverCallback({
          transactionId: "tx-456",
          status: "completed",
          callbackUrl: "https://partner-wallet.org/notifications",
          payload: { transaction_id: "tx-456" },
        }),
      ).rejects.toThrow("Callback delivery failed with HTTP 503: Service Unavailable");
    });
  });

  describe("4. Worker Delivery & Retry Handling", () => {
    it("should process callback and log success when deliverCallback succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue("Acknowledged"),
      });

      const mockJob = {
        id: "job-101",
        data: {
          transactionId: "tx-success-1",
          status: "completed",
          callbackUrl: "https://external-client.com/sep24",
          payload: { test: true },
        },
        attemptsMade: 1,
      };

      await registeredWorkerProcessor(mockJob);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Delivered callback successfully for transaction tx-success-1"),
      );
    });

    it("should propagate error during transient failure for BullMQ to schedule retry", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue("Internal Error"),
      });

      const mockJob = {
        id: "job-102",
        data: {
          transactionId: "tx-fail-1",
          status: "pending_anchor",
          callbackUrl: "https://external-client.com/sep24",
          payload: {},
        },
        attemptsMade: 2,
      };

      await expect(registeredWorkerProcessor(mockJob)).rejects.toThrow("Callback delivery failed with HTTP 500");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Delivery attempt 2/5 failed for transaction tx-fail-1"),
      );
    });
  });

  describe("5. Dead-Letter Queue Logging on Max Retries Exhaustion", () => {
    it("should write dead-letter error log and invoke handleFailedJob when attempts are exhausted", async () => {
      const mockJob: any = {
        id: "job-exhausted-1",
        data: {
          transactionId: "tx-deadletter-1",
          status: "failed",
          callbackUrl: "https://unreachable-endpoint.org/webhook",
          payload: { error: "deposit_rejected" },
        },
        attemptsMade: 5,
      };

      const error = new Error("Connection timed out after 30s");

      await handleExhaustedCallback(mockJob, error);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[DLQ] Dead-letter log: exhausted delivery attempts (5/5) for callback on transaction tx-deadletter-1"),
        expect.objectContaining({
          jobId: "job-exhausted-1",
          transactionId: "tx-deadletter-1",
          callbackUrl: "https://unreachable-endpoint.org/webhook",
          attemptsMade: 5,
          exhausted: true,
        }),
      );

      expect(handleFailedJob).toHaveBeenCalledWith(
        mockJob,
        error,
        CALLBACK_QUEUE_NAME,
      );
    });

    it("should be idempotent and avoid duplicate DLQ handling for the same job", async () => {
      const mockJob: any = {
        id: "job-exhausted-2",
        data: {
          transactionId: "tx-deadletter-2",
          status: "failed",
          callbackUrl: "https://unreachable-endpoint.org/webhook",
          payload: {},
        },
        attemptsMade: 5,
      };

      const error = new Error("Gateway Timeout");

      await handleExhaustedCallback(mockJob, error);
      await handleExhaustedCallback(mockJob, error);

      expect(handleFailedJob).toHaveBeenCalledTimes(1);
    });

    it("should handle exhausted delivery directly inside worker processor when attemptsMade reaches max", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 504,
        text: jest.fn().mockResolvedValue("Gateway Timeout"),
      });

      const mockJob: any = {
        id: "job-exhausted-worker",
        data: {
          transactionId: "tx-exhausted-in-worker",
          status: "completed",
          callbackUrl: "https://external-client.com/sep24",
          payload: {},
        },
        attemptsMade: 5,
      };

      await expect(registeredWorkerProcessor(mockJob)).rejects.toThrow("Callback delivery failed with HTTP 504");
      expect(handleFailedJob).toHaveBeenCalledWith(
        mockJob,
        expect.any(Error),
        CALLBACK_QUEUE_NAME,
      );
    });
  });

  describe("6. SEP-24 Transaction Status Change Emitter to Queue Dispatcher", () => {
    it("should automatically enqueue callback retry when statusChange event is emitted with callback URL", async () => {
      mockQueueAdd.mockResolvedValueOnce({ id: "job-event-dispatched" });

      const testEmitter = new EventEmitter();
      registerSep24CallbackDispatcher(testEmitter);

      testEmitter.emit("statusChange", {
        transactionId: "tx-event-01",
        status: "completed",
        callbackUrl: "https://client-wallet.com/callback",
        transaction: { id: "tx-event-01", status: "completed", amount_out: "50" },
      });

      // Allow async event handler to complete
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "deliver-callback",
        expect.objectContaining({
          transactionId: "tx-event-01",
          status: "completed",
          callbackUrl: "https://client-wallet.com/callback",
        }),
        expect.any(Object),
      );
    });

    it("should not enqueue callback retry when event lacks callbackUrl", async () => {
      const testEmitter = new EventEmitter();
      registerSep24CallbackDispatcher(testEmitter);

      testEmitter.emit("statusChange", {
        transactionId: "tx-event-02",
        status: "pending_anchor",
        transaction: { id: "tx-event-02", status: "pending_anchor" },
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("7. Lifecycle Teardown", () => {
    it("should close worker and queue during graceful shutdown", async () => {
      await closeCallbackQueue();

      expect(mockWorkerClose).toHaveBeenCalled();
      expect(mockQueueClose).toHaveBeenCalled();
    });
  });
});
