import express from "express";
import request from "supertest";
import winston from "winston";
import Transport from "winston-transport";
import {
  correlationIdMiddleware,
  getCurrentCorrelationId,
} from "../../middleware/correlationId";
import { requestContext } from "../../utils/logger";
import {
  injectCorrelationId,
  correlationIdFromJob,
  withJobCorrelationContext,
  JOB_CORRELATION_ID_KEY,
} from "../correlationContext";

/** Captures log records written during a test, independent of the app's real logger config. */
class CapturingTransport extends Transport {
  public records: Record<string, unknown>[] = [];
  log(info: Record<string, unknown>, callback: () => void) {
    this.records.push(info);
    callback();
  }
}

describe("BullMQ correlation ID propagation (#2381)", () => {
  describe("injectCorrelationId (enqueue side)", () => {
    it("stamps the active request's correlation ID onto job data", async () => {
      const app = express();
      app.use(correlationIdMiddleware);

      let capturedJobData: Record<string, unknown> | undefined;
      app.get("/enqueue", (_req, res) => {
        capturedJobData = injectCorrelationId({ transactionId: "tx-1" });
        res.status(202).json({ queued: true });
      });

      const response = await request(app)
        .get("/enqueue")
        .set("X-Correlation-ID", "req-correlation-123");

      expect(response.status).toBe(202);
      expect(capturedJobData).toMatchObject({
        transactionId: "tx-1",
        [JOB_CORRELATION_ID_KEY]: "req-correlation-123",
      });
    });

    it("generates a fresh correlation ID when called outside any request context", () => {
      const jobData = injectCorrelationId({ transactionId: "tx-2" });

      expect(typeof jobData[JOB_CORRELATION_ID_KEY]).toBe("string");
      expect(jobData[JOB_CORRELATION_ID_KEY].length).toBeGreaterThan(0);
    });

    it("preserves other fields on the job payload unchanged", () => {
      const jobData = injectCorrelationId({
        transactionId: "tx-3",
        amount: 100,
        nested: { foo: "bar" },
      });

      expect(jobData.transactionId).toBe("tx-3");
      expect(jobData.amount).toBe(100);
      expect(jobData.nested).toEqual({ foo: "bar" });
    });
  });

  describe("correlationIdFromJob (worker side)", () => {
    it("extracts a previously injected correlation ID", () => {
      const jobData = injectCorrelationId({ transactionId: "tx-4" });
      expect(correlationIdFromJob(jobData)).toBe(
        jobData[JOB_CORRELATION_ID_KEY],
      );
    });

    it("returns undefined for a job enqueued before propagation was added", () => {
      expect(correlationIdFromJob({ transactionId: "tx-5" })).toBeUndefined();
    });

    it("returns undefined for undefined job data", () => {
      expect(correlationIdFromJob(undefined)).toBeUndefined();
    });
  });

  describe("withJobCorrelationContext (worker side)", () => {
    it("makes the job's correlation ID available via getCurrentCorrelationId() inside the callback", async () => {
      const jobData = injectCorrelationId({ transactionId: "tx-6" });

      let seenDuringJob: string | undefined;
      await withJobCorrelationContext(jobData, async () => {
        seenDuringJob = getCurrentCorrelationId();
      });

      expect(seenDuringJob).toBe(jobData[JOB_CORRELATION_ID_KEY]);
    });

    it("auto-stamps every Winston log line written during job processing with the propagated correlation_id (#2381)", async () => {
      const capture = new CapturingTransport();
      const testLogger = winston.createLogger({
        format: winston.format.combine(
          winston.format((info) => {
            const store = requestContext.getStore();
            if (store?.correlation_id) {
              (info as any).correlation_id = store.correlation_id;
            }
            return info;
          })(),
        ),
        transports: [capture],
      });

      const jobData = injectCorrelationId({ transactionId: "tx-7" });

      await withJobCorrelationContext(jobData, async () => {
        testLogger.info("processing job step 1");
        testLogger.info("processing job step 2");
      });

      expect(capture.records).toHaveLength(2);
      for (const record of capture.records) {
        expect(record.correlation_id).toBe(jobData[JOB_CORRELATION_ID_KEY]);
      }
    });

    it("propagates the correlation ID across an await boundary spanning multiple async steps (multi-step transaction)", async () => {
      const jobData = injectCorrelationId({ transactionId: "tx-8" });
      const seen: Array<string | undefined> = [];

      await withJobCorrelationContext(jobData, async () => {
        seen.push(getCurrentCorrelationId());
        await new Promise((resolve) => setTimeout(resolve, 0));
        seen.push(getCurrentCorrelationId());
        await Promise.resolve().then(() => {
          seen.push(getCurrentCorrelationId());
        });
      });

      expect(seen).toEqual([
        jobData[JOB_CORRELATION_ID_KEY],
        jobData[JOB_CORRELATION_ID_KEY],
        jobData[JOB_CORRELATION_ID_KEY],
      ]);
    });

    it("generates a fresh correlation ID for a job that predates propagation, rather than leaving logs unstamped", async () => {
      let seenDuringJob: string | undefined;

      await withJobCorrelationContext({ transactionId: "legacy-job" }, async () => {
        seenDuringJob = getCurrentCorrelationId();
      });

      expect(typeof seenDuringJob).toBe("string");
      expect(seenDuringJob!.length).toBeGreaterThan(0);
    });

    it("isolates correlation context between two jobs processed one after another", async () => {
      const jobA = injectCorrelationId({ transactionId: "tx-a" });
      const jobB = injectCorrelationId({ transactionId: "tx-b" });

      const seenA: Array<string | undefined> = [];
      const seenB: Array<string | undefined> = [];

      await withJobCorrelationContext(jobA, async () => {
        seenA.push(getCurrentCorrelationId());
      });
      await withJobCorrelationContext(jobB, async () => {
        seenB.push(getCurrentCorrelationId());
      });

      expect(seenA[0]).toBe(jobA[JOB_CORRELATION_ID_KEY]);
      expect(seenB[0]).toBe(jobB[JOB_CORRELATION_ID_KEY]);
      expect(seenA[0]).not.toBe(seenB[0]);
    });
  });

  describe("end-to-end: HTTP request → enqueue → job processing", () => {
    it("carries one correlation ID from the originating HTTP request through to job processing", async () => {
      const app = express();
      app.use(correlationIdMiddleware);

      let enqueuedJobData: Record<string, unknown> | undefined;
      app.post("/transactions", (_req, res) => {
        // Simulates `await queue.add(jobName, injectCorrelationId(data))`.
        enqueuedJobData = injectCorrelationId({ transactionId: "tx-e2e" });
        res.status(202).json({ queued: true });
      });

      const response = await request(app)
        .post("/transactions")
        .set("X-Correlation-ID", "e2e-correlation-id");

      expect(response.status).toBe(202);

      // Simulates the BullMQ worker picking the job up later, in its own
      // async context with no ambient requestContext of its own.
      let seenInWorker: string | undefined;
      await withJobCorrelationContext(enqueuedJobData, async () => {
        seenInWorker = getCurrentCorrelationId();
      });

      expect(seenInWorker).toBe("e2e-correlation-id");
    });
  });
});
