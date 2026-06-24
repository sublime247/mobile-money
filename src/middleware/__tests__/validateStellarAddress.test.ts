import { Request, Response, NextFunction } from "express";
import { validateStellarAddressMiddleware } from "../validateStellarAddress";

describe("validateStellarAddressMiddleware", () => {
  let req: Partial<Request<{ address?: string }>>;
  let res: Partial<Response>;
  let next: NextFunction;
  let statusCode: number | undefined;
  let jsonData: unknown;

  beforeEach(() => {
    statusCode = undefined;
    jsonData = undefined;

    req = {
      params: {},
    };

    res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: unknown) => {
        jsonData = data;
        return res;
      },
    };

    next = jest.fn();
  });

  it("allows a valid Stellar G-address", () => {
    req.params = {
      address: "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A",
    };

    validateStellarAddressMiddleware(
      req as Request<{ address: string }>,
      res as Response,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(statusCode).toBeUndefined();
    expect(jsonData).toBeUndefined();
  });

  it("rejects malformed addresses", () => {
    req.params = { address: "INVALID_ADDRESS" };

    validateStellarAddressMiddleware(
      req as Request<{ address: string }>,
      res as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(statusCode).toBe(400);
    expect(jsonData).toEqual({
      error: "Validation failed",
      details: [
        {
          path: "address",
          message: "Invalid Stellar G-address",
        },
      ],
    });
  });
});
