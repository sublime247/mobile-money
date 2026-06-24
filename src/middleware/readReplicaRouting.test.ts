import { Request, Response, NextFunction } from "express";
import {
  readReplicaRoutingMiddleware,
  isReadOperation,
  isWriteOperation,
} from "../readReplicaRouting";

describe("readReplicaRoutingMiddleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      method: "GET",
      path: "/test",
    };
    res = {};
    next = jest.fn();
  });

  describe("isReadOperation", () => {
    it("should identify GET as a read operation", () => {
      expect(isReadOperation("GET")).toBe(true);
    });

    it("should identify HEAD as a read operation", () => {
      expect(isReadOperation("HEAD")).toBe(true);
    });

    it("should identify OPTIONS as a read operation", () => {
      expect(isReadOperation("OPTIONS")).toBe(true);
    });

    it("should identify POST as a write operation", () => {
      expect(isReadOperation("POST")).toBe(false);
    });

    it("should identify PUT as a write operation", () => {
      expect(isReadOperation("PUT")).toBe(false);
    });

    it("should identify PATCH as a write operation", () => {
      expect(isReadOperation("PATCH")).toBe(false);
    });

    it("should identify DELETE as a write operation", () => {
      expect(isReadOperation("DELETE")).toBe(false);
    });

    it("should handle case insensitivity", () => {
      expect(isReadOperation("get")).toBe(true);
      expect(isReadOperation("Get")).toBe(true);
      expect(isReadOperation("post")).toBe(false);
    });
  });

  describe("isWriteOperation", () => {
    it("should identify write operations correctly", () => {
      expect(isWriteOperation("POST")).toBe(true);
      expect(isWriteOperation("PUT")).toBe(true);
      expect(isWriteOperation("PATCH")).toBe(true);
      expect(isWriteOperation("DELETE")).toBe(true);
    });

    it("should return false for read operations", () => {
      expect(isWriteOperation("GET")).toBe(false);
      expect(isWriteOperation("HEAD")).toBe(false);
    });
  });

  describe("middleware routing context", () => {
    it("should set useReplicaPool to true for GET requests", () => {
      req.method = "GET";
      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(req.dbRouting).toBeDefined();
      expect(req.dbRouting?.useReplicaPool).toBe(true);
      expect(req.dbRouting?.method).toBe("GET");
      expect(next).toHaveBeenCalled();
    });

    it("should set useReplicaPool to true for HEAD requests", () => {
      req.method = "HEAD";
      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(req.dbRouting?.useReplicaPool).toBe(true);
    });

    it("should set useReplicaPool to false for POST requests", () => {
      req.method = "POST";
      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(req.dbRouting?.useReplicaPool).toBe(false);
      expect(req.dbRouting?.method).toBe("POST");
    });

    it("should set useReplicaPool to false for PUT requests", () => {
      req.method = "PUT";
      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(req.dbRouting?.useReplicaPool).toBe(false);
    });

    it("should set useReplicaPool to false for DELETE requests", () => {
      req.method = "DELETE";
      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(req.dbRouting?.useReplicaPool).toBe(false);
    });

    it("should attach path information", () => {
      req.path = "/api/users/123";
      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(req.dbRouting?.path).toBe("/api/users/123");
    });

    it("should call next middleware", () => {
      readReplicaRoutingMiddleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("should not throw when method is lowercase", () => {
      req.method = "get";
      expect(() => {
        readReplicaRoutingMiddleware(req as Request, res as Response, next);
      }).not.toThrow();
      expect(req.dbRouting?.useReplicaPool).toBe(true);
    });
  });

  describe("logging in development", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      jest.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      (console.log as jest.Mock).mockRestore();
    });

    it("should log routing decision when DEBUG_DB_ROUTING is enabled", () => {
      process.env.NODE_ENV = "development";
      process.env.DEBUG_DB_ROUTING = "true";
      req.method = "GET";
      req.path = "/users";

      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("DB Routing"),
      );
    });

    it("should not log when DEBUG_DB_ROUTING is false", () => {
      process.env.NODE_ENV = "development";
      process.env.DEBUG_DB_ROUTING = "false";

      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(console.log).not.toHaveBeenCalled();
    });

    it("should not log in production", () => {
      process.env.NODE_ENV = "production";
      process.env.DEBUG_DB_ROUTING = "true";

      readReplicaRoutingMiddleware(req as Request, res as Response, next);

      expect(console.log).not.toHaveBeenCalled();
    });
  });
});
