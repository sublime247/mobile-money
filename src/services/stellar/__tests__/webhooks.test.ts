import { createHmac } from "crypto";

jest.mock("bullmq", () => {
  const addFn = jest.fn();
  const closeFn = jest.fn();
  (global as any).mockQueueAdd = addFn;
  (global as any).mockWorkerClose = closeFn;
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: addFn,
      close: jest.fn(),
    })),
    Worker: jest.fn().mockImplementation((name, processor) => {
      (global as any).registeredProcessor = processor;
      return {
        on: jest.fn(),
        close: closeFn,
      };
    }),
  };
});

import { enqueueSepWebhook, sepWebhookQueue, sepWebhookWorker } from "../webhooks";

const getMockQueueAdd = () => (global as any).mockQueueAdd;
const getRegisteredProcessor = () => (global as any).registeredProcessor;

describe("SEP Webhooks Service and Worker", () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_WEBHOOK_SECRET = "test-secret";

    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    delete process.env.STELLAR_WEBHOOK_SECRET;
  });

  describe("enqueueSepWebhook", () => {
    it("should add a job to the sep-webhooks queue with the correct parameters", async () => {
      const transactionId = "tx-123";
      const status = "completed";
      const callbackUrl = "https://example.com/callback";
      const payload = { id: transactionId, status };

      await enqueueSepWebhook(transactionId, status, callbackUrl, payload);

      expect(getMockQueueAdd()).toHaveBeenCalledWith(
        "send-webhook",
        {
          transactionId,
          status,
          callbackUrl,
          payload,
        },
        expect.objectContaining({
          attempts: 5,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
        })
      );
    });

    it("should skip enqueuing when no callbackUrl is provided", async () => {
      const transactionId = "tx-123";
      const status = "completed";
      const payload = { id: transactionId, status };

      await enqueueSepWebhook(transactionId, status, "", payload);

      expect(getMockQueueAdd()).not.toHaveBeenCalled();
    });
  });

  describe("sepWebhookWorker", () => {
    it("should successfully deliver a signed payload to the callback URL", async () => {
      const jobData = {
        transactionId: "tx-123",
        status: "completed",
        callbackUrl: "https://example.com/callback",
        payload: { id: "tx-123", status: "completed" },
      };

      const mockJob = {
        id: "job-1",
        data: jobData,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue("Success"),
      });

      const processor = getRegisteredProcessor();
      expect(processor).toBeDefined();

      await processor(mockJob);

      const expectedBody = JSON.stringify(jobData.payload);
      const expectedSignature = "sha256=" + createHmac("sha256", "test-secret").update(expectedBody).digest("hex");

      expect(mockFetch).toHaveBeenCalledWith("https://example.com/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stellar-Signature": expectedSignature,
        },
        body: expectedBody,
      });
    });

    it("should throw an error and trigger a retry when fetch returns non-ok status", async () => {
      const jobData = {
        transactionId: "tx-123",
        status: "completed",
        callbackUrl: "https://example.com/callback",
        payload: { id: "tx-123", status: "completed" },
      };

      const mockJob = {
        id: "job-1",
        data: jobData,
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue("Internal Server Error"),
      });

      const processor = getRegisteredProcessor();
      expect(processor).toBeDefined();
      
      await expect(processor(mockJob)).rejects.toThrow("HTTP error 500: Internal Server Error");
    });
  });
});
