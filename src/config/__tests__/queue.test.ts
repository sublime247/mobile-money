/**
 * Dead-Letter Queue (DLQ) Unit Tests (#1989)
 *
 * Acceptance Criteria verified:
 *   [✓] Capture failed job name, payload, error stack trace, and timestamps in failed_jobs table
 *   [✓] Expose admin endpoint to inspect and replay failed dead-letter jobs
 *   [✓] Send alert notification when DLQ receives new failed job
 */

import {
  handleFailedJob,
  attachDlqListener,
  replayDeadLetterJob,
  listDeadLetterJobs,
} from "../queue";
import { pool } from "../database";
import { deadLetterQueue } from "../../queue/dlq";
import { notificationRouter } from "../../services/notificationRouter";

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: "replayed-job-1" }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn(),
}));

jest.mock("../database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../queue/dlq", () => ({
  deadLetterQueue: {
    add: jest.fn().mockResolvedValue({ id: "dlq-job-1" }),
    getJobs: jest.fn().mockResolvedValue([]),
  },
  DLQ_NAME: "transaction-dlq",
}));

jest.mock("../../services/notificationRouter", () => ({
  notificationRouter: {
    routeSystemNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

describe("Dead-Letter Queue (DLQ) for Failed Background Tasks (#1989)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("handleFailedJob", () => {
    it("captures failed job details in failed_jobs table, enqueues to DLQ, and sends alert notification", async () => {
      const mockJob: any = {
        id: "job-101",
        queueName: "webhook-delivery-queue",
        name: "send-merchant-webhook",
        data: { url: "https://merchant.example/webhook", event: "deposit.success" },
        attemptsMade: 5,
        opts: { attempts: 5 },
      };

      const mockError = new Error("Connection timeout after 5 retries");
      mockError.stack = "Error: Connection timeout\n  at Object.<anonymous>";

      const mockDbRow = {
        id: "failed-job-uuid-1",
        job_id: "job-101",
        queue_name: "webhook-delivery-queue",
        job_name: "send-merchant-webhook",
        payload: mockJob.data,
        error_message: "Connection timeout after 5 retries",
        error_stack: mockError.stack,
        attempts_made: 5,
        status: "failed",
        failed_at: new Date().toISOString(),
      };

      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [mockDbRow],
        rowCount: 1,
      });

      const result = await handleFailedJob(mockJob, mockError);

      // 1. Verify database insertion
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO failed_jobs"),
        expect.arrayContaining([
          "job-101",
          "webhook-delivery-queue",
          "send-merchant-webhook",
          JSON.stringify(mockJob.data),
          "Connection timeout after 5 retries",
          mockError.stack,
          5,
          expect.any(String),
        ]),
      );
      expect(result).toEqual(mockDbRow);

      // 2. Verify BullMQ DLQ addition
      expect(deadLetterQueue.add).toHaveBeenCalledWith(
        "failed-webhook-delivery-queue-send-merchant-webhook",
        expect.objectContaining({
          originalJobId: "job-101",
          queueName: "webhook-delivery-queue",
          jobName: "send-merchant-webhook",
          errorMessage: "Connection timeout after 5 retries",
          attemptsMade: 5,
        }),
        expect.objectContaining({
          removeOnComplete: false,
          attempts: 1,
        }),
      );

      expect(notificationRouter.routeSystemNotification).toHaveBeenCalledWith(
        "critical",
        "system",
        expect.stringContaining("DLQ Alert"),
        expect.stringContaining("webhook-delivery-queue"),
        expect.objectContaining({
          jobId: "job-101",
          queueName: "webhook-delivery-queue",
        }),
      );
    });
  });

  describe("replayDeadLetterJob", () => {
    it("re-enqueues failed dead-letter job and updates status to replayed", async () => {
      const mockFailedJob = {
        id: "failed-job-uuid-1",
        job_id: "job-101",
        queue_name: "sms-notification-queue",
        job_name: "send-sms-alert",
        payload: { phone: "+237671234567", text: "Deposit confirmed" },
        status: "failed",
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockFailedJob], rowCount: 1 }) // SELECT
        .mockResolvedValueOnce({
          rows: [{ ...mockFailedJob, status: "replayed", replayed_at: new Date().toISOString() }],
          rowCount: 1,
        }); // UPDATE

      const result = await replayDeadLetterJob("failed-job-uuid-1");

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM failed_jobs WHERE id = $1"),
        ["failed-job-uuid-1"],
      );
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE failed_jobs"),
        ["failed-job-uuid-1"],
      );
      expect(result.success).toBe(true);
      expect(result.job.record.status).toBe("replayed");
    });

    it("throws error if failed job record does not exist", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(replayDeadLetterJob("non-existent-id")).rejects.toThrow(
        "Failed job not found with ID: non-existent-id",
      );
    });
  });

  describe("listDeadLetterJobs", () => {
    it("queries failed jobs with pagination and filters", async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: "10" }] }) // count query
        .mockResolvedValueOnce({
          rows: [
            { id: "1", queue_name: "email-queue", status: "failed" },
            { id: "2", queue_name: "email-queue", status: "failed" },
          ],
        }); // data query

      const result = await listDeadLetterJobs({
        limit: 20,
        offset: 0,
        queueName: "email-queue",
        status: "failed",
      });

      expect(result.total).toBe(10);
      expect(result.jobs.length).toBe(2);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT COUNT(*) FROM failed_jobs"),
        ["email-queue", "failed"],
      );
    });
  });

  describe("attachDlqListener", () => {
    it("attaches failed and error listeners to worker", () => {
      const mockWorker: any = {
        name: "test-worker",
        on: jest.fn(),
      };

      attachDlqListener(mockWorker);

      expect(mockWorker.on).toHaveBeenCalledWith("failed", expect.any(Function));
      expect(mockWorker.on).toHaveBeenCalledWith("error", expect.any(Function));
    });
  });
});
