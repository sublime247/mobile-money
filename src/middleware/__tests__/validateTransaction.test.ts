import { Request, Response, NextFunction } from "express";
import { validateTransaction } from "../validateTransaction";

describe("validateTransaction middleware", () => {
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

  describe("Stellar address validation", () => {
    it("should accept valid G-address", (done) => {
      req.body = {
        amount: 100,
        phoneNumber: "+1234567890",
        provider: "mtn",
        stellarAddress:
          "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, () => {
        expect(next).not.toHaveBeenCalled();
        done();
      });

      expect(next).toHaveBeenCalled();
    });

    it("should accept valid M-address (muxed account)", (done) => {
      req.body = {
        amount: 100,
        phoneNumber: "+1234567890",
        provider: "mtn",
        // M-address with memo ID 123456
        stellarAddress:
          "MDQEVDDKALTIIVIMVLYJ5YZOOU32DELTA7GFF2Y4YESRLG53XCISYMCB2X6ROUTE",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, () => {
        expect(next).not.toHaveBeenCalled();
        done();
      });

      expect(next).toHaveBeenCalled();
    });

    it("should reject invalid Stellar address", () => {
      req.body = {
        amount: 100,
        phoneNumber: "+1234567890",
        provider: "mtn",
        stellarAddress: "INVALID_ADDRESS",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(400);
      expect(jsonData).toEqual(
        expect.objectContaining({
          error: "Validation failed",
          details: expect.any(Array),
        }),
      );
    });

    it("should reject malformed M-address", () => {
      req.body = {
        amount: 100,
        phoneNumber: "+1234567890",
        provider: "mtn",
        stellarAddress:
          "MDQEVDDKALTIIVIMVLYJ5YZOOU32DELTA7GFF2Y4YESRLG53XCISYNOTVALIDMUXED",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(400);
    });

    it("should reject empty address", () => {
      req.body = {
        amount: 100,
        phoneNumber: "+1234567890",
        provider: "mtn",
        stellarAddress: "",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(400);
    });
  });

  describe("Other validations", () => {
    it("should reject invalid amount", () => {
      req.body = {
        amount: -100,
        phoneNumber: "+1234567890",
        provider: "mtn",
        stellarAddress:
          "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(400);
    });

    it("should reject invalid provider", () => {
      req.body = {
        amount: 100,
        phoneNumber: "+1234567890",
        provider: "invalid_provider",
        stellarAddress:
          "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(400);
    });

    it("should reject invalid phone number", () => {
      req.body = {
        amount: 100,
        phoneNumber: "123", // too short
        provider: "mtn",
        stellarAddress:
          "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(400);
    });

    it("should accept valid request with all correct fields", () => {
      req.body = {
        amount: 50.5,
        phoneNumber: "+237670000000",
        provider: "mtn",
        stellarAddress:
          "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A",
        userId: "user123",
      };

      validateTransaction(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(statusCode).toBe(200);
    });
  });
});
