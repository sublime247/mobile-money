import express, { Request, Response } from "express";
import http from "http";
import request from "supertest";
import {
  createGracefulShutdownHandler,
  GracefulShutdownHandler,
} from "../../server";

describe("Graceful Shutdown Handler Integration Tests (#1991)", () => {
  let app: express.Express;
  let server: http.Server;
  let shutdownHandler: GracefulShutdownHandler;
  let mockPool: { end: jest.Mock };
  let mockDisconnectRedis: jest.Mock;
  let mockRedisClient: { quit: jest.Mock; disconnect: jest.Mock };

  beforeEach(() => {
    app = express();
    mockPool = {
      end: jest.fn().mockResolvedValue(undefined),
    };
    mockDisconnectRedis = jest.fn().mockResolvedValue(undefined);
    mockRedisClient = {
      quit: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    shutdownHandler = createGracefulShutdownHandler({
      pool: mockPool,
      disconnectRedis: mockDisconnectRedis,
      timeoutMs: 2000,
      exitProcess: false,
    });

    app.use(shutdownHandler.middleware);

    app.get("/quick", (_req: Request, res: Response) => {
      res.status(200).json({ status: "ok" });
    });

    server = http.createServer(app);
    shutdownHandler.setServer(server);
  });

  afterEach(async () => {
    if (server && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should process normal requests when not shutting down", async () => {
    const res = await request(app).get("/quick");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(shutdownHandler.getActiveRequests()).toBe(0);
    expect(shutdownHandler.getIsShuttingDown()).toBe(false);
  });

  it("should stop accepting new HTTP connections and return 503 on shutdown signal", async () => {
    await shutdownHandler.shutdown("SIGTERM");

    expect(shutdownHandler.getIsShuttingDown()).toBe(true);

    const res = await request(app).get("/quick");
    expect(res.status).toBe(503);
    expect(res.headers["connection"]).toBe("close");
  });

  it("should allow in-flight requests to complete before closing", async () => {
    let requestReceivedResolve: () => void = () => {};
    const requestReceived = new Promise<void>((r) => {
      requestReceivedResolve = r;
    });

    app.get("/slow-tracked", (_req: Request, res: Response) => {
      requestReceivedResolve();
      setTimeout(() => {
        res.status(200).json({ status: "slow-completed" });
      }, 100);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as { port: number; address: string };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let inFlightCompleted = false;
    let inFlightResponseStatus = 0;

    // Start a slow in-flight request
    const slowReqPromise = fetch(`${baseUrl}/slow-tracked`)
      .then((res) => {
        inFlightResponseStatus = res.status;
        return res.json();
      })
      .then((body: any) => {
        if (body.status === "slow-completed") {
          inFlightCompleted = true;
        }
      });

    // Wait until the request has definitively reached Express middleware and handler
    await requestReceived;
    expect(shutdownHandler.getActiveRequests()).toBeGreaterThanOrEqual(1);

    // Trigger shutdown while slow request is in flight
    const shutdownPromise = shutdownHandler.shutdown("SIGINT");

    // Any new request is rejected with 503
    const newReqRes = await fetch(`${baseUrl}/quick`).catch((err) => ({
      status: 503,
      err,
    }));
    if ("status" in newReqRes) {
      expect([503, 0]).toContain(newReqRes.status);
    }

    await Promise.all([slowReqPromise, shutdownPromise]);

    expect(inFlightCompleted).toBe(true);
    expect(inFlightResponseStatus).toBe(200);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
    expect(mockDisconnectRedis).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  });

  it("should close Redis client and PostgreSQL pool connections gracefully", async () => {
    const onCleanup = jest.fn().mockResolvedValue(undefined);
    const onShutdownStart = jest.fn().mockResolvedValue(undefined);

    const handler = new GracefulShutdownHandler({
      server,
      pool: mockPool,
      redisClient: mockRedisClient,
      onCleanup,
      onShutdownStart,
      exitProcess: false,
    });

    await handler.shutdown("SIGTERM");

    expect(onShutdownStart).toHaveBeenCalledWith("SIGTERM");
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.quit).toHaveBeenCalledTimes(1);
  });

  it("should force-close hanging requests when timeout expires", async () => {
    let hangReceivedResolve: () => void = () => {};
    const hangReceived = new Promise<void>((r) => {
      hangReceivedResolve = r;
    });

    const shortTimeoutHandler = new GracefulShutdownHandler({
      pool: mockPool,
      disconnectRedis: mockDisconnectRedis,
      timeoutMs: 150, // short 150ms timeout
      exitProcess: false,
    });

    const testApp = express();
    testApp.use(shortTimeoutHandler.middleware);
    testApp.get("/hang", (_req, _res) => {
      hangReceivedResolve();
      // Intentionally never respond
    });

    const testServer = http.createServer(testApp);
    shortTimeoutHandler.setServer(testServer);

    await new Promise<void>((resolve) => {
      testServer.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = testServer.address() as { port: number; address: string };
    // Start hanging request
    fetch(`http://127.0.0.1:${addr.port}/hang`).catch(() => {});

    await hangReceived;
    expect(shortTimeoutHandler.getActiveRequests()).toBe(1);

    const startedAt = Date.now();
    await shortTimeoutHandler.shutdown("SIGTERM");
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(mockPool.end).toHaveBeenCalled();
    expect(mockDisconnectRedis).toHaveBeenCalled();
    expect(testServer.listening).toBe(false);
  });

  it("should register and unregister signal handlers cleanly", () => {
    const unregister = shutdownHandler.registerSignalHandlers();
    expect(typeof unregister).toBe("function");
    expect(() => unregister()).not.toThrow();
  });
});
