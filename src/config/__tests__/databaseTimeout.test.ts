import { isQueryCanceledError } from "../databaseErrors";
import { ERROR_CODES, getHttpStatus } from "../../constants/errorCodes";
import { errorHandler, AppError } from "../../middleware/errorHandler";
import { Request, Response } from "express";

describe("Database Query Execution Timeout Guardrails (#1990)", () => {
  describe("Default statement timeout configuration", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
      jest.resetModules();
    });

    it("sets default client statement_timeout = 15000 on pool options", () => {
      delete process.env.DB_STATEMENT_TIMEOUT_MS;
      jest.isolateModules(() => {
        const { pool } = require("../database");
        expect(pool.options.statement_timeout).toBe(15000);
      });
    });

    it("allows overriding statement_timeout via DB_STATEMENT_TIMEOUT_MS", () => {
      process.env.DB_STATEMENT_TIMEOUT_MS = "20000";
      jest.isolateModules(() => {
        const { pool } = require("../database");
        expect(pool.options.statement_timeout).toBe(20000);
      });
    });
  });

  describe("isQueryCanceledError detection", () => {
    it("detects PostgreSQL 57014 code", () => {
      const error = { code: "57014", message: "canceling statement due to statement timeout" };
      expect(isQueryCanceledError(error)).toBe(true);
    });

    it("detects statement timeout message hints", () => {
      const error = new Error("canceling statement due to statement timeout");
      expect(isQueryCanceledError(error)).toBe(true);
    });

    it("detects query_canceled message hint", () => {
      const error = new Error("Query failed: query_canceled");
      expect(isQueryCanceledError(error)).toBe(true);
    });

    it("returns false for non-timeout errors", () => {
      const error = new Error("syntax error at or near SELECT");
      expect(isQueryCanceledError(error)).toBe(false);
    });
  });

  describe("HTTP 504 Gateway Timeout Mapping", () => {
    it("maps GATEWAY_TIMEOUT to 504 status", () => {
      expect(getHttpStatus(ERROR_CODES.GATEWAY_TIMEOUT)).toBe(504);
      expect(getHttpStatus("57014")).toBe(504);
      expect(getHttpStatus("QUERY_TIMEOUT")).toBe(504);
    });

    it("handles 57014 in errorHandler and returns 504 Gateway Timeout", () => {
      const pgError: any = new Error("canceling statement due to statement timeout");
      pgError.code = "57014";

      const req: Partial<Request> = {
        headers: { "accept-language": "en" },
      };

      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res: Partial<Response> = {
        status: statusMock,
      };

      errorHandler(pgError as AppError, req as Request, res as Response, jest.fn());

      expect(statusMock).toHaveBeenCalledWith(504);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: ERROR_CODES.GATEWAY_TIMEOUT,
          statusCode: 504,
          message: expect.stringContaining("Database query timed out"),
        }),
      );
    });
  });
});
