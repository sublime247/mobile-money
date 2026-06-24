import { PoolClient } from "pg";

import {
  dbConnectionLeakDetector,
  getConnectionTrackerCount,
  getLeakedConnections,
  forceReleaseAllConnections,
  trackConnectionCheckout,
  getTrackedConnections,
} from "../../src/middleware/dbConnectionLeakDetector";

jest.mock("../../src/utils/logger");

describe("DB Connection Leak Detector Middleware", () => {
  beforeEach(() => {
    getTrackedConnections().clear();
    Object.defineProperty(process.env, "DB_LEAK_LOG_THRESHOLD_MS", {
      value: "100",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.env, "DB_LEAK_ALERT_THRESHOLD_SECONDS", {
      value: "1",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    delete process.env.DB_LEAK_LOG_THRESHOLD_MS;
    delete process.env.DB_LEAK_ALERT_THRESHOLD_SECONDS;
  });

  describe("dbConnectionLeakDetector middleware", () => {
    it("should call next() to continue request processing", () => {
      const mockReq = {
        method: "GET",
        path: "/test",
        headers: {},
        on: jest.fn(),
        route: { path: "/test" },
      } as any;
      const mockRes = {
        on: jest.fn(),
      } as any;
      const mockNext = jest.fn();

      dbConnectionLeakDetector(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should set up request cleanup on close/finish events", () => {
      const mockReq = {
        method: "GET",
        path: "/test",
        headers: {},
        on: jest.fn(),
        route: { path: "/test" },
      } as any;
      const mockRes = {
        on: jest.fn(),
      } as any;
      const mockNext = jest.fn();

      dbConnectionLeakDetector(mockReq, mockRes, mockNext);

      expect(mockReq.on).toHaveBeenCalledWith("close", expect.any(Function));
      expect(mockRes.on).toHaveBeenCalledWith("finish", expect.any(Function));
    });
  });

  describe("trackConnectionCheckout", () => {
    it("should track connection checkout with stack trace", () => {
      const mockClient = {
        processID: 99999,
        release: jest.fn().mockReturnValue({}),
      } as unknown as PoolClient;

      trackConnectionCheckout(mockClient);

      const tracked = getTrackedConnections().get(mockClient.processID);
      expect(tracked).toBeDefined();
      expect(tracked?.checkoutStack).toContain("Error");
      expect(getConnectionTrackerCount()).toBe(1);
    });

    it("should accept custom endpoint and method", () => {
      const mockClient = {
        processID: 88888,
        release: jest.fn().mockReturnValue({}),
      } as unknown as PoolClient;

      trackConnectionCheckout(mockClient, {
        endpoint: "custom-endpoint.ts",
        method: "POST",
        requestId: "test-request-id",
      });

      const tracked = getTrackedConnections().get(mockClient.processID);
      expect(tracked?.endpoint).toBe("custom-endpoint.ts");
      expect(tracked?.method).toBe("POST");
      expect(tracked?.requestId).toBe("test-request-id");
    });

    it("should wrap client release with leak detection", () => {
      const mockClient = {
        processID: 77777,
        release: jest.fn().mockReturnValue({}),
      } as unknown as PoolClient;

      trackConnectionCheckout(mockClient, { endpoint: "test.ts", method: "GET" });

      const wrappedRelease = (mockClient as any).release;
      const tracked = getTrackedConnections().get(mockClient.processID);

      expect(typeof wrappedRelease).toBe("function");
      expect(tracked).toBeDefined();
    });

    it("should remove connection from tracking on release", () => {
      const mockClient = {
        processID: 66666,
        release: jest.fn().mockReturnValue({}),
      } as unknown as PoolClient;

      trackConnectionCheckout(mockClient, { endpoint: "test.ts", method: "GET" });
      expect(getConnectionTrackerCount()).toBe(1);

      (mockClient as any).release();
      expect(getConnectionTrackerCount()).toBe(0);
    });

    it("should record slow connection return as warning", () => {
      const mockClient = {
        processID: 55555,
        release: jest.fn(),
      } as unknown as PoolClient;

      const originalRelease = mockClient.release.bind(mockClient);

      trackConnectionCheckout(mockClient, { endpoint: "test.ts", method: "GET" });

      (mockClient as any).release = jest.fn().mockReturnValue({});

      const wrappedRelease = (mockClient as any).release;
      (wrappedRelease as jest.Mock).mockImplementation(function (this: any) {
        const tracked = getTrackedConnections().get(mockClient.processID);
        if (tracked) {
          tracked.checkedOutAt = Date.now() - 200;
        }
        return originalRelease();
      });

      (mockClient as any).release();

      expect(require("../../src/utils/logger").default.warn).toHaveBeenCalled();
    });
  });

  describe("getLeakedConnections", () => {
    it("should return empty array when no connections are leaked", () => {
      const freshConnection = {
        processID: 33333,
        release: jest.fn(),
      } as unknown as PoolClient;

      getTrackedConnections().set(freshConnection.processID, {
        client: freshConnection,
        checkedOutAt: Date.now(),
        checkoutStack: "fresh stack",
        endpoint: "fresh.ts",
        method: "POST",
      });

      const leaked = getLeakedConnections();
      expect(leaked.length).toBe(0);
    });

    it("should return connections held longer than threshold", () => {
      const oldConnection = {
        processID: 22222,
        release: jest.fn(),
      } as unknown as PoolClient;

      getTrackedConnections().set(oldConnection.processID, {
        client: oldConnection,
        checkedOutAt: Date.now() - 5000,
        checkoutStack: "old stack",
        endpoint: "old.ts",
        method: "GET",
      });

      const leaked = getLeakedConnections();
      expect(leaked.length).toBe(1);
      expect(leaked[0].client.processID).toBe(22222);
    });
  });

  describe("forceReleaseAllConnections", () => {
    it("should force release all tracked connections", () => {
      const mockClient1 = {
        processID: 44444,
        release: jest.fn().mockReturnValue({}),
      } as unknown as PoolClient;
      const mockClient2 = {
        processID: 11111,
        release: jest.fn().mockReturnValue({}),
      } as unknown as PoolClient;

      getTrackedConnections().set(mockClient1.processID, {
        client: mockClient1,
        checkedOutAt: Date.now(),
        checkoutStack: "stack 1",
        endpoint: "file1.ts",
        method: "GET",
      });
      getTrackedConnections().set(mockClient2.processID, {
        client: mockClient2,
        checkedOutAt: Date.now(),
        checkoutStack: "stack 2",
        endpoint: "file2.ts",
        method: "POST",
      });

      const released = forceReleaseAllConnections();

      expect(released).toBe(2);
      expect(mockClient1.release).toHaveBeenCalled();
      expect(mockClient2.release).toHaveBeenCalled();
      expect(getConnectionTrackerCount()).toBe(0);
    });

    it("should handle errors during force release gracefully", () => {
      const mockClient = {
        processID: 99999,
        release: jest.fn().mockImplementation(() => {
          throw new Error("Release failed");
        }),
      } as unknown as PoolClient;

      getTrackedConnections().set(mockClient.processID, {
        client: mockClient,
        checkedOutAt: Date.now(),
        checkoutStack: "stack",
        endpoint: "file.ts",
        method: "GET",
      });

      const released = forceReleaseAllConnections();

      expect(released).toBe(1);
      expect(require("../../src/utils/logger").default.error).toHaveBeenCalled();
    });
  });

  describe("getConnectionTrackerCount", () => {
    it("should return correct count of tracked connections", () => {
      getTrackedConnections().clear();

      const mockClient = {
        processID: 77777,
        release: jest.fn(),
      } as unknown as PoolClient;

      getTrackedConnections().set(mockClient.processID, {
        client: mockClient,
        checkedOutAt: Date.now(),
        checkoutStack: "stack",
        endpoint: "file.ts",
        method: "GET",
      });

      expect(getConnectionTrackerCount()).toBe(1);
    });

    it("should return 0 when no connections are tracked", () => {
      getTrackedConnections().clear();
      expect(getConnectionTrackerCount()).toBe(0);
    });
  });

  describe("startPeriodicLeakCheck", () => {
    it("should return null in test environment", () => {
      const interval = require("../../src/middleware/dbConnectionLeakDetector")
        .startPeriodicLeakCheck as typeof startPeriodicLeakCheck;

      const result = interval(1000);
      expect(result).toBeNull();
    });
  });
});