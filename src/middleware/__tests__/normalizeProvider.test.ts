import { Request, Response, NextFunction } from "express";
import { normalizeProvider } from "../normalizeProvider";

describe("normalizeProvider middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      body: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  it("normalizes lowercase provider to uppercase", () => {
    mockRequest.body = { provider: "mtn" };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.body.provider).toBe("MTN");
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it("normalizes mixed case provider to uppercase", () => {
    mockRequest.body = { provider: "Mtn" };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.body.provider).toBe("MTN");
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it("accepts already uppercase provider", () => {
    mockRequest.body = { provider: "MTN" };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.body.provider).toBe("MTN");
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it("normalizes airtel to uppercase", () => {
    mockRequest.body = { provider: "airtel" };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.body.provider).toBe("AIRTEL");
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it("normalizes orange to uppercase", () => {
    mockRequest.body = { provider: "orange" };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.body.provider).toBe("ORANGE");
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it("rejects invalid provider name", () => {
    mockRequest.body = { provider: "invalid" };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: "Validation failed",
      details: [
        {
          path: "provider",
          message: "Provider must be one of: MTN, AIRTEL, ORANGE",
        },
      ],
    });
  });

  it("rejects missing provider field", () => {
    mockRequest.body = {};

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: "Validation failed",
      details: [
        {
          path: "provider",
          message: "Provider field is required",
        },
      ],
    });
  });

  it("handles numeric provider string", () => {
    mockRequest.body = { provider: 123 };

    normalizeProvider(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.body.provider).toBe("123");
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(400);
  });
});
