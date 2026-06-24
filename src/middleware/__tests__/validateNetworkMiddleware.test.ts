import { Request, Response, NextFunction } from "express";
import { validateNetworkMiddleware } from "../validateNetworkMiddleware";

describe("validateNetworkMiddleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let statusCode: number;
  let jsonData: unknown;

  beforeEach(() => {
    statusCode = 200;
    jsonData = null;

    req = {
      body: {},
    };

    res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: unknown) => {
        jsonData = data;
      },
    };

    next = jest.fn();
  });

  it("should resolve MTN for a valid international phone number", () => {
    req.body = {
      phoneNumber: "+237670000000",
    };

    validateNetworkMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect((req.body as any).resolvedNetwork).toBe("MTN");
    expect(statusCode).toBe(200);
  });

  it("should resolve ORANGE for a valid local phone number", () => {
    req.body = {
      phoneNumber: "22507123456",
    };

    validateNetworkMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect((req.body as any).resolvedNetwork).toBe("ORANGE");
  });

  it("should reject unsupported network prefixes", () => {
    req.body = {
      phoneNumber: "+1234567890",
    };

    validateNetworkMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusCode).toBe(400);
    expect(jsonData).toEqual(
      expect.objectContaining({
        error: "Validation failed",
        details: expect.any(Array),
      }),
    );
  });
});
