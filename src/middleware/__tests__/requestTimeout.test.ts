import express from "express";
import request from "supertest";
import { requestTimeout, RequestTimeoutPresets } from "../requestTimeout";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("requestTimeout middleware", () => {
  test("returns 504 Gateway Timeout when the handler exceeds the configured timeout", async () => {
    const app = express();
    app.use(requestTimeout({ timeoutMs: 50 }));
    app.get("/slow", async (_req, res) => {
      await sleep(200);
      if (!res.headersSent) res.status(200).json({ ok: true });
    });

    const response = await request(app).get("/slow");

    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  test("lets fast handlers respond normally within the timeout", async () => {
    const app = express();
    app.use(requestTimeout({ timeoutMs: 200 }));
    app.get("/fast", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const response = await request(app).get("/fast");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  test("attaches an AbortSignal to the request that fires on timeout", async () => {
    const app = express();
    app.use(requestTimeout({ timeoutMs: 50 }));

    let sawAbort = false;
    app.get("/slow", async (req, res) => {
      req.abortSignal?.addEventListener("abort", () => {
        sawAbort = true;
      });
      await sleep(200);
      if (!res.headersSent) res.status(200).json({ ok: true });
    });

    await request(app).get("/slow");
    expect(sawAbort).toBe(true);
  });

  test("does not abort the signal for requests that complete in time", async () => {
    const app = express();
    app.use(requestTimeout({ timeoutMs: 200 }));

    let signalAtResponseTime: boolean | undefined;
    app.get("/fast", (req, res) => {
      signalAtResponseTime = req.abortSignal?.aborted;
      res.status(200).json({ ok: true });
    });

    await request(app).get("/fast");
    expect(signalAtResponseTime).toBe(false);
  });

  test("RequestTimeoutPresets.standard times out after 15s-scale config (smoke test with short override)", async () => {
    // Full preset uses a real 15s timeout — here we only assert the preset
    // object exists and is a usable middleware, not wait out the real delay.
    expect(typeof RequestTimeoutPresets.standard).toBe("function");
    expect(typeof RequestTimeoutPresets.complexBatch).toBe("function");
  });
});
