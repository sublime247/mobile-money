import { Job } from "bullmq";

// Mock BullMQ module to prevent it from establishing real Redis socket connections
// during unit and integration test runs, avoiding ECONNREFUSED log pollution.
jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation(() => {
      return {
        add: jest.fn().mockResolvedValue({ id: "mock-job-id" }),
        getJob: jest.fn(),
        getWaitingCount: jest.fn().mockResolvedValue(0),
        getActiveCount: jest.fn().mockResolvedValue(0),
        getCompletedCount: jest.fn().mockResolvedValue(0),
        getFailedCount: jest.fn().mockResolvedValue(0),
        isPaused: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
      };
    }),
    Worker: jest.fn().mockImplementation(() => {
      return {
        close: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

// Mock the logger to prevent external log sink connections during tests
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
  },
}));

// Mock the accounting retry queue to prevent Redis connections
jest.mock("../../src/queue/accountingRetryQueue", () => ({
  __esModule: true,
  addAccountingRetryJob: jest.fn().mockResolvedValue(undefined),
  getAccountingRetryJobById: jest.fn(),
  getAccountingRetryQueueStats: jest.fn().mockResolvedValue({
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    isPaused: false,
  }),
  accountingRetryQueue: {
    add: jest.fn().mockResolvedValue({ id: "mock-retry-job-id" }),
    close: jest.fn().mockResolvedValue(undefined),
  },
}));

import { processSyncJob, accountingService } from "../../src/queue/syncWorker";
import { SyncJobData, SyncJobResult } from "../../src/queue/syncQueue";
import {
  RateLimitError,
  NetworkError,
  ValidationError,
} from "../../src/services/accounting/accountingService";
import logger from "../../src/utils/logger";

describe("Accounting Integration (QuickBooks & Xero Sync Retry Queue)", () => {
  let mockJob: Partial<Job<SyncJobData, SyncJobResult>>;

  beforeEach(() => {
    jest.clearAllMocks();
    accountingService.setMockFailures("quickbooks", 0);
    accountingService.setMockFailures("xero", 0);

    // Mock BullMQ Job structure
    mockJob = {
      id: "test-sync-job-1",
      attemptsMade: 0,
      discard: jest.fn().mockResolvedValue(undefined),
      opts: {
        attempts: 5,
      },
      data: {
        syncId: "sync-12345",
        transactionId: "tx-67890",
        platform: "quickbooks",
        payload: {
          amount: "5000",
          referenceNumber: "REF-QBO-001",
          phoneNumber: "+237670000000",
          provider: "MTN",
          stellarAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          completedAt: new Date().toISOString(),
        },
      },
    };
  });

  describe("Successful Sync Operations", () => {
    it("should successfully sync a valid transaction to QuickBooks", async () => {
      const result = await processSyncJob(
        mockJob as Job<SyncJobData, SyncJobResult>,
      );

      expect(result.success).toBe(true);
      expect(result.syncId).toBe("sync-12345");
      expect(result.platform).toBe("quickbooks");
    });

    it("should successfully sync a valid transaction to Xero", async () => {
      mockJob.data!.platform = "xero";
      mockJob.data!.payload.referenceNumber = "REF-XERO-002";

      const result = await processSyncJob(
        mockJob as Job<SyncJobData, SyncJobResult>,
      );

      expect(result.success).toBe(true);
      expect(result.syncId).toBe("sync-12345");
      expect(result.platform).toBe("xero");
    });
  });

  describe("Transient Outages and Retries (Backoff)", () => {
    it("should throw a transient error (RateLimitError) when QuickBooks rate limits are hit", async () => {
      // Set QuickBooks mock failure
      accountingService.setMockFailures("quickbooks", 1, "rate-limit");

      await expect(
        processSyncJob(mockJob as Job<SyncJobData, SyncJobResult>),
      ).rejects.toThrow(RateLimitError);

      // Verify logger.warn was called for transient error
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          isTransient: true,
          platform: "quickbooks",
        }),
        expect.stringContaining("Transient error"),
      );
      expect(mockJob.discard).not.toHaveBeenCalled();
    });

    it("should throw a transient error (NetworkError) when Xero connection fails", async () => {
      mockJob.data!.platform = "xero";
      accountingService.setMockFailures("xero", 1, "network");

      await expect(
        processSyncJob(mockJob as Job<SyncJobData, SyncJobResult>),
      ).rejects.toThrow(NetworkError);

      // Verify logger.warn was called for transient error
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          isTransient: true,
          platform: "xero",
        }),
        expect.stringContaining("Transient error"),
      );
      expect(mockJob.discard).not.toHaveBeenCalled();
    });
  });

  describe("Permanent Failures (No Retry)", () => {
    it("should discard future attempts and throw ValidationError when amount is zero/negative", async () => {
      mockJob.data!.payload.amount = "0";

      await expect(
        processSyncJob(mockJob as Job<SyncJobData, SyncJobResult>),
      ).rejects.toThrow(ValidationError);

      // Verify BullMQ job.discard was invoked to cancel retries permanently
      expect(mockJob.discard).toHaveBeenCalledTimes(1);
      
      // Verify logger.error was called for permanent error
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          isPermanent: true,
          platform: "quickbooks",
        }),
        expect.stringContaining("Permanent error"),
      );
    });

    it("should discard future attempts and throw ValidationError when reference number is missing for Xero", async () => {
      mockJob.data!.platform = "xero";
      mockJob.data!.payload.referenceNumber = "";

      await expect(
        processSyncJob(mockJob as Job<SyncJobData, SyncJobResult>),
      ).rejects.toThrow(ValidationError);

      expect(mockJob.discard).toHaveBeenCalledTimes(1);
      
      // Verify logger.error was called for permanent error
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          isPermanent: true,
          platform: "xero",
        }),
        expect.stringContaining("Permanent error"),
      );
    });
  });
});
