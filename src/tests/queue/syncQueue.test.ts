export {};

const mockAdd = jest.fn();
const mockGetJob = jest.fn();
const mockGetWaitingCount = jest.fn();
const mockGetActiveCount = jest.fn();
const mockGetCompletedCount = jest.fn();
const mockGetFailedCount = jest.fn();
const mockIsPaused = jest.fn();

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getWaitingCount: mockGetWaitingCount,
    getActiveCount: mockGetActiveCount,
    getCompletedCount: mockGetCompletedCount,
    getFailedCount: mockGetFailedCount,
    isPaused: mockIsPaused,
  })),
}));

jest.mock("../../queue/config", () => ({
  queueOptions: {},
}));

import {
  addSyncJob,
  getSyncJobById,
  getSyncQueueStats,
  SyncJobData,
} from "../../queue/syncQueue";

describe("syncQueue helper functions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const sampleData: SyncJobData = {
    syncId: "sync-123",
    transactionId: "tx-456",
    platform: "quickbooks",
    payload: {
      amount: "100.00",
      referenceNumber: "REF-001",
      phoneNumber: "+254712345678",
      provider: "MPESA",
      stellarAddress: "G" + "A".repeat(55),
      completedAt: new Date().toISOString(),
    },
  };

  describe("addSyncJob", () => {
    it("enqueues a job using data.syncId as default jobId when options are omitted", async () => {
      mockAdd.mockResolvedValueOnce({ id: "sync-123" });

      const res = await addSyncJob(sampleData);

      expect(mockAdd).toHaveBeenCalledWith("sync-operation", sampleData, {
        jobId: "sync-123",
        priority: undefined,
        delay: undefined,
      });
      expect(res).toEqual({ id: "sync-123" });
    });

    it("uses data.syncId as default jobId when options object is passed without jobId (priority/delay only)", async () => {
      mockAdd.mockResolvedValueOnce({ id: "sync-123" });

      const res = await addSyncJob(sampleData, { priority: 5, delay: 1000 });

      expect(mockAdd).toHaveBeenCalledWith("sync-operation", sampleData, {
        jobId: "sync-123",
        priority: 5,
        delay: 1000,
      });
      expect(res).toEqual({ id: "sync-123" });
    });

    it("enqueues a job with custom jobId, priority, and delay options", async () => {
      mockAdd.mockResolvedValueOnce({ id: "custom-job-id" });

      const res = await addSyncJob(sampleData, {
        jobId: "custom-job-id",
        priority: 2,
        delay: 5000,
      });

      expect(mockAdd).toHaveBeenCalledWith("sync-operation", sampleData, {
        jobId: "custom-job-id",
        priority: 2,
        delay: 5000,
      });
      expect(res).toEqual({ id: "custom-job-id" });
    });
  });

  describe("getSyncJobById", () => {
    it("calls syncQueue.getJob with the provided jobId", async () => {
      const mockJob = { id: "job-abc", data: sampleData };
      mockGetJob.mockResolvedValueOnce(mockJob);

      const job = await getSyncJobById("job-abc");

      expect(mockGetJob).toHaveBeenCalledWith("job-abc");
      expect(job).toBe(mockJob);
    });
  });

  describe("getSyncQueueStats", () => {
    it("returns aggregated health metrics from the queue when active and unpaused", async () => {
      mockGetWaitingCount.mockResolvedValueOnce(5);
      mockGetActiveCount.mockResolvedValueOnce(2);
      mockGetCompletedCount.mockResolvedValueOnce(100);
      mockGetFailedCount.mockResolvedValueOnce(3);
      mockIsPaused.mockResolvedValueOnce(false);

      const stats = await getSyncQueueStats();

      expect(stats).toEqual({
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        isPaused: false,
      });
      expect(mockGetWaitingCount).toHaveBeenCalledTimes(1);
      expect(mockGetActiveCount).toHaveBeenCalledTimes(1);
      expect(mockGetCompletedCount).toHaveBeenCalledTimes(1);
      expect(mockGetFailedCount).toHaveBeenCalledTimes(1);
      expect(mockIsPaused).toHaveBeenCalledTimes(1);
    });

    it("returns correctly formatted stats when queue is paused and counts are zero", async () => {
      mockGetWaitingCount.mockResolvedValueOnce(0);
      mockGetActiveCount.mockResolvedValueOnce(0);
      mockGetCompletedCount.mockResolvedValueOnce(0);
      mockGetFailedCount.mockResolvedValueOnce(0);
      mockIsPaused.mockResolvedValueOnce(true);

      const stats = await getSyncQueueStats();

      expect(stats).toEqual({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        isPaused: true,
      });
    });
  });
});

