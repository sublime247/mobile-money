import express from "express";
import request from "supertest";
import { createMetricsRouter } from "../../routes/metrics";
import {
  mtnPushCountry,
  mtnPushOutcome,
  recordUssdPushDispatch,
  recordUssdPushOutcome,
  ussdPushRequestsTotal,
} from "../metrics";

describe("USSD push metrics", () => {
  beforeEach(() => {
    ussdPushRequestsTotal.reset();
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  it("exports dispatches and terminal outcomes on the application registry", async () => {
    recordUssdPushDispatch("mpesa", "KE", "checkout-1");
    recordUssdPushOutcome("mpesa", "KE", "checkout-1", "success");
    recordUssdPushOutcome("mpesa", "KE", "checkout-1", "success");

    recordUssdPushDispatch(
      "mtn",
      mtnPushCountry("+233241234567"),
      "collection-1",
    );
    recordUssdPushOutcome("mtn", "unknown", "collection-1", "failed", true);
    jest.advanceTimersByTime(300_000);

    const app = express().use(
      "/metrics",
      createMetricsRouter({ authEnabled: false, internalOnly: false }),
    );
    const { text: metrics } = await request(app).get("/metrics").expect(200);
    expect(metrics).toContain("# TYPE ussd_push_requests_total counter");
    expect(metrics).toContain(
      'ussd_push_requests_total{provider="mpesa",country="KE",status="dispatched"} 1',
    );
    expect(metrics).toContain(
      'ussd_push_requests_total{provider="mpesa",country="KE",status="success"} 1',
    );
    expect(metrics).toContain(
      'ussd_push_requests_total{provider="mtn",country="GH",status="failed"} 1',
    );
    expect(metrics).not.toContain('status="timeout"');
  });

  it("counts an unanswered prompt once and recognizes provider timeouts", async () => {
    recordUssdPushDispatch("mpesa", "KE", "checkout-2");
    jest.advanceTimersByTime(300_000);
    recordUssdPushOutcome("mpesa", "KE", "checkout-2", "failed");

    const { values } = await ussdPushRequestsTotal.get();
    expect(values).toHaveLength(2);
    expect(values).toContainEqual(
      expect.objectContaining({
        labels: { provider: "mpesa", country: "KE", status: "timeout" },
        value: 1,
      }),
    );
    expect(mtnPushOutcome("FAILED", "PAYER_TIMEOUT")).toBe("timeout");
    expect(mtnPushOutcome("PENDING", undefined)).toBeUndefined();
  });
});
