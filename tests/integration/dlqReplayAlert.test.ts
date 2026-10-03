import express from "express";
import request from "supertest";
import {
  DlqMonitorService,
  dlqMonitorService,
} from "../../src/services/dlqMonitorService";
import { replayFilteredQueueJobsHandler } from "../../src/routes/admin";
import { pool } from "../../src/config/database";
import * as queueConfig from "../../src/config/queue";
import { dlqTotal, dlqReplayed, register } from "../../src/utils/metrics";
import { errorHandler } from "../../src/middleware/errorHandler";

jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../src/config/queue", () => ({
  replayDeadLetterJob: jest.fn(),
  listDeadLetterJobs: jest.fn(),
}));

jest.mock("../../src/queue/dlq", () => ({
  DLQ_NAME: "transaction-dlq",
  deadLetterQueue: {
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
  },
  dlqInspectorHandler: jest.fn((_req: any, res: any) =>
    res.json({ success: true }),
  ),
}));

describe("Dead-Letter Queue (DLQ) Automated Replay and Alert Worker (#2162)", () => {
  let app: express.Express;
  let service: DlqMonitorService;

  const mockFailedJobs: queueConfig.FailedJobRecord[] = [
    {
      id: "job-uuid-1",
      job_id: "bullmq-1",
      queue_name: "transaction-queue",
      job_name: "process-momo-transfer",
      payload: { transactionId: "tx-1", amount: 5000 },
      error_message: "PROVIDER_TIMEOUT: MTN gateway did not respond within 30000ms",
      attempts_made: 3,
      status: "failed",
      failed_at: "2026-10-02T08:00:00.000Z",
      created_at: "2026-10-02T08:00:00.000Z",
      updated_at: "2026-10-02T08:00:00.000Z",
    },
    {
      id: "job-uuid-2",
      job_id: "bullmq-2",
      queue_name: "transaction-queue",
      job_name: "process-momo-transfer",
      payload: { transactionId: "tx-2", amount: 10000 },
      error_message: "HTTP_504_GATEWAY_TIMEOUT: Upstream Orange Money connection dropped",
      attempts_made: 3,
      status: "failed",
      failed_at: "2026-10-02T08:05:00.000Z",
      created_at: "2026-10-02T08:05:00.000Z",
      updated_at: "2026-10-02T08:05:00.000Z",
    },
    {
      id: "job-uuid-3",
      job_id: "bullmq-3",
      queue_name: "transaction-queue",
      job_name: "process-momo-transfer",
      payload: { transactionId: "tx-3", amount: 2000 },
      error_message: "INVALID_ACCOUNT_NUMBER: Destination MSISDN is malformed",
      attempts_made: 3,
      status: "failed",
      failed_at: "2026-10-02T08:10:00.000Z",
      created_at: "2026-10-02T08:10:00.000Z",
      updated_at: "2026-10-02T08:10:00.000Z",
    },
  ];

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.post("/api/admin/queues/replay", replayFilteredQueueJobsHandler);
    app.use(errorHandler);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DlqMonitorService({
      alertThreshold: 5,
      checkIntervalMs: 5000,
      queueName: "transaction-queue",
    });
  });

  afterEach(() => {
    service.stop();
  });

  describe("Acceptance Criterion 1: Background DLQ Depth Monitoring & Threshold Alerting", () => {
    it("updates dlq_total metric and does not alert when depth is below threshold", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ count: 3 }],
      });

      const result = await service.checkDlqDepth("transaction-queue");

      expect(result.depth).toBe(3);
      expect(result.alerted).toBe(false);
      expect(service.getAlertHistory()).toHaveLength(0);

      // Verify Prometheus metric updated
      const metricValue = await dlqTotal.get();
      const matchingValue = metricValue.values.find(
        (v) => v.labels.queue === "transaction-queue",
      );
      expect(matchingValue?.value).toBe(3);
    });

    it("triggers alert notification when DLQ depth exceeds threshold", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ count: 12 }],
      });

      const result = await service.checkDlqDepth("transaction-queue");

      expect(result.depth).toBe(12);
      expect(result.alerted).toBe(true);
      expect(service.getAlertHistory()).toHaveLength(1);
      expect(service.getAlertHistory()[0].message).toContain(
        "exceeding alert threshold of 5",
      );

      const metricValue = await dlqTotal.get();
      const matchingValue = metricValue.values.find(
        (v) => v.labels.queue === "transaction-queue",
      );
      expect(matchingValue?.value).toBe(12);
    });

    it("delivers webhook alerts to Slack and Telegram endpoints when configured", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });
      global.fetch = mockFetch;

      const webhookService = new DlqMonitorService({
        alertThreshold: 2,
        queueName: "transaction-queue",
        slackWebhookUrl: "https://hooks.slack.com/services/TEST/DLQ/ALERT",
        telegramBotToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        telegramChatId: "-1001234567890",
      });

      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ count: 10 }],
      });

      const status = await webhookService.checkDlqDepth("transaction-queue");

      expect(status.alerted).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify Slack call
      expect(mockFetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/TEST/DLQ/ALERT",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("DLQ ALERT"),
        }),
      );

      // Verify Telegram call
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("Mobile Money DLQ Alert"),
        }),
      );
    });

    it("manages worker start and stop lifecycle cleanly", () => {
      expect(service.isRunning()).toBe(false);
      service.start(1000);
      expect(service.isRunning()).toBe(true);
      service.stop();
      expect(service.isRunning()).toBe(false);
    });
  });

  describe("Acceptance Criterion 2: Admin Replay Endpoint /api/admin/queues/replay", () => {
    it("safely filters and replays failed jobs matching specified error codes", async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: mockFailedJobs }) // Select query
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }); // Post-replay count check

      (queueConfig.replayDeadLetterJob as jest.Mock).mockResolvedValue({
        success: true,
        job: { replayedJobId: "replayed-new-id" },
      });

      const res = await request(app)
        .post("/api/admin/queues/replay")
        .send({
          queueName: "transaction-queue",
          errorCodes: ["TIMEOUT", "504"],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalMatched).toBe(2);
      expect(res.body.replayedCount).toBe(2);
      expect(res.body.failedCount).toBe(0);

      // Verify only jobs 1 & 2 were replayed, NOT job 3 (which had INVALID_ACCOUNT_NUMBER)
      expect(queueConfig.replayDeadLetterJob).toHaveBeenCalledTimes(2);
      expect(queueConfig.replayDeadLetterJob).toHaveBeenCalledWith("job-uuid-1");
      expect(queueConfig.replayDeadLetterJob).toHaveBeenCalledWith("job-uuid-2");
      expect(queueConfig.replayDeadLetterJob).not.toHaveBeenCalledWith("job-uuid-3");
    });

    it("supports dryRun mode to inspect matching jobs without executing replay", async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: mockFailedJobs })
        .mockResolvedValueOnce({ rows: [{ count: 3 }] });

      const res = await request(app)
        .post("/api/admin/queues/replay")
        .send({
          queueName: "transaction-queue",
          errorCodes: ["TIMEOUT"],
          dryRun: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.replayedCount).toBe(0);
      expect(res.body.skippedCount).toBe(2);
      expect(res.body.jobs).toHaveLength(2);
      expect(res.body.jobs[0].status).toBe("matched");

      // Verify replayDeadLetterJob was NOT called
      expect(queueConfig.replayDeadLetterJob).not.toHaveBeenCalled();
    });

    it("rejects invalid errorCodes parameter format with 400 Bad Request", async () => {
      const res = await request(app)
        .post("/api/admin/queues/replay")
        .send({
          errorCodes: "NOT_AN_ARRAY",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(
        "errorCodes parameter must be an array of string error codes",
      );
    });

    it("rejects invalid limit parameter with 400 Bad Request", async () => {
      const res = await request(app)
        .post("/api/admin/queues/replay")
        .send({
          limit: -5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(
        "limit parameter must be a positive integer",
      );
    });

    it("tracks failed replays when individual job replay encounters an error", async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockFailedJobs[0]] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] });

      (queueConfig.replayDeadLetterJob as jest.Mock).mockRejectedValueOnce(
        new Error("Target BullMQ Redis queue disconnected"),
      );

      const res = await request(app)
        .post("/api/admin/queues/replay")
        .send({
          queueName: "transaction-queue",
          jobIds: ["job-uuid-1"],
        });

      expect(res.status).toBe(200);
      expect(res.body.replayedCount).toBe(0);
      expect(res.body.failedCount).toBe(1);
      expect(res.body.jobs[0].status).toBe("failed");
      expect(res.body.jobs[0].error).toContain("Target BullMQ Redis queue disconnected");
    });
  });

  describe("Acceptance Criterion 3: Prometheus Metrics dlq_total & dlq_replayed", () => {
    it("increments dlq_replayed metric with success and failed labels", async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockFailedJobs[0], mockFailedJobs[1]] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] });

      (queueConfig.replayDeadLetterJob as jest.Mock)
        .mockResolvedValueOnce({ success: true, job: { replayedJobId: "job-ok" } })
        .mockRejectedValueOnce(new Error("Downstream reject"));

      await service.replayFailedJobs({
        queueName: "transaction-queue",
      });

      const metricsOutput = await register.metrics();
      expect(metricsOutput).toContain("dlq_replayed");
      expect(metricsOutput).toContain('queue="transaction-queue"');
      expect(metricsOutput).toContain('status="success"');
      expect(metricsOutput).toContain('status="failed"');
    });
  });
});
