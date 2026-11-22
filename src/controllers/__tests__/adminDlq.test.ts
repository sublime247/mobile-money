import { Request, Response } from "express";
import {
  getDeadLetterJobsHandler,
  getDeadLetterJobByIdHandler,
  replayDeadLetterJobHandler,
} from "../adminController";
import * as queueConfig from "../../config/queue";
import { pool } from "../../config/database";

jest.mock("../../config/queue", () => ({
  listDeadLetterJobs: jest.fn(),
  replayDeadLetterJob: jest.fn(),
}));

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

describe("Admin DLQ Controller Endpoints (#1989)", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    mockReq = {};
    mockRes = {
      json: jsonMock,
      status: statusMock,
    };
  });

  describe("getDeadLetterJobsHandler", () => {
    it("returns paginated dead letter jobs", async () => {
      mockReq.query = { limit: "10", offset: "0", queueName: "webhook-queue" };
      (queueConfig.listDeadLetterJobs as jest.Mock).mockResolvedValueOnce({
        total: 1,
        jobs: [{ id: "job-1", queue_name: "webhook-queue" }],
      });

      await getDeadLetterJobsHandler(mockReq as Request, mockRes as Response);

      expect(queueConfig.listDeadLetterJobs).toHaveBeenCalledWith({
        limit: 10,
        offset: 0,
        queueName: "webhook-queue",
        status: undefined,
      });
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        total: 1,
        jobs: [{ id: "job-1", queue_name: "webhook-queue" }],
      });
    });
  });

  describe("getDeadLetterJobByIdHandler", () => {
    it("returns specific dead letter job when found", async () => {
      mockReq.params = { id: "job-uuid-1" };
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: "job-uuid-1", queue_name: "sms-queue" }],
      });

      await getDeadLetterJobByIdHandler(mockReq as Request, mockRes as Response);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM failed_jobs WHERE id = $1"),
        ["job-uuid-1"],
      );
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        job: { id: "job-uuid-1", queue_name: "sms-queue" },
      });
    });

    it("throws 404 error when job is not found", async () => {
      mockReq.params = { id: "non-existent-id" };
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await expect(
        getDeadLetterJobByIdHandler(mockReq as Request, mockRes as Response),
      ).rejects.toThrow("Failed job not found with ID: non-existent-id");
    });
  });

  describe("replayDeadLetterJobHandler", () => {
    it("replays dead letter job and returns success response", async () => {
      mockReq.params = { id: "job-uuid-1" };
      (queueConfig.replayDeadLetterJob as jest.Mock).mockResolvedValueOnce({
        success: true,
        job: { replayedJobId: "bullmq-job-99" },
      });

      await replayDeadLetterJobHandler(mockReq as Request, mockRes as Response);

      expect(queueConfig.replayDeadLetterJob).toHaveBeenCalledWith("job-uuid-1");
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        message: "Failed dead-letter job replayed successfully",
        job: { replayedJobId: "bullmq-job-99" },
      });
    });

    it("throws missing field error if ID param is missing", async () => {
      mockReq.params = {};

      await expect(
        replayDeadLetterJobHandler(mockReq as Request, mockRes as Response),
      ).rejects.toThrow("Failed job ID is required for replay");
    });
  });
});
