import { Request, Response } from "express";
import {
  sanitizationMiddleware,
  detectMaliciousPayload,
  deepSanitize,
} from "../sanitization";

describe("Sanitization Middleware & Utilities", () => {
  describe("detectMaliciousPayload", () => {
    it("should detect NoSQL operator injections in object keys", () => {
      const payload = {
        username: "admin",
        password: { $gt: "" },
      };
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
      expect(result.reason).toContain("NoSQL operator");
    });

    it("should detect NoSQL $ne operator injection", () => {
      const payload = {
        user: { $ne: null },
      };
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
    });

    it("should detect SQL injection UNION SELECT", () => {
      const payload = "1' UNION SELECT * FROM users --";
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
      expect(result.reason).toContain("SQL injection");
    });

    it("should detect SQL injection DROP TABLE", () => {
      const payload = { query: "Robert'; DROP TABLE students;--" };
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
    });

    it("should detect SQL injection 1=1 OR", () => {
      const payload = { query: "admin' OR 1=1 --" };
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
    });

    it("should detect XSS script tags", () => {
      const payload = "<script>alert('XSS')</script>";
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
      expect(result.reason).toContain("Script tag");
    });

    it("should detect XSS event handlers", () => {
      const payload = { comment: "<img src=x onerror=alert(1)>" };
      const result = detectMaliciousPayload(payload);
      expect(result.malicious).toBe(true);
      expect(result.reason).toContain("XSS");
    });

    it("should pass benign strings with international Unicode, phone numbers, and currency symbols", () => {
      const safeData = {
        name: "François Müller-Ndiaye 🌍",
        phone: "+237 670 123 456",
        amount: "50,000 XAF",
        price: "$100.50 €85.00 £70.00 ¥15,000 ₦20,000",
        bio: "Sending money home to Côte d'Ivoire & Sénégal.",
        items: [{ desc: "Payment for goods", currency: "EUR" }],
      };

      const result = detectMaliciousPayload(safeData);
      expect(result.malicious).toBe(false);
    });
  });

  describe("deepSanitize", () => {
    it("should preserve valid Unicode, phone numbers, and currency symbols", () => {
      const input = {
        name: "René François",
        phone: "+1234567890",
        currency: "€/$ / ₦",
      };
      const output = deepSanitize(input);
      expect(output).toEqual(input);
    });

    it("should strip null bytes from strings and keys", () => {
      const input = {
        "user\0name": "test\0value",
      };
      const output = deepSanitize(input) as Record<string, string>;
      expect(output.username).toBe("testvalue");
    });
  });

  describe("sanitizationMiddleware Express integration", () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let nextFunction: jest.Mock;
    let statusMock: jest.Mock;
    let jsonMock: jest.Mock;

    beforeEach(() => {
      jsonMock = jest.fn();
      statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      mockRes = {
        status: statusMock,
      };
      nextFunction = jest.fn();
    });

    it("should reject malicious SQL injection in query with HTTP 400", () => {
      mockReq = {
        query: { search: "1' UNION SELECT username, password FROM users --" },
        params: {},
        body: {},
      };

      sanitizationMiddleware(mockReq as Request, mockRes as Response, nextFunction);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Bad Request",
          message: expect.stringContaining("SQL injection"),
        }),
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should reject malicious NoSQL injection in body with HTTP 400", () => {
      mockReq = {
        query: {},
        params: {},
        body: {
          username: "admin",
          password: { $gt: "" },
        },
      };

      sanitizationMiddleware(mockReq as Request, mockRes as Response, nextFunction);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Bad Request",
          message: expect.stringContaining("NoSQL operator"),
        }),
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should reject malicious XSS script tags in query with HTTP 400", () => {
      mockReq = {
        query: { redirect: "<script>alert(document.cookie)</script>" },
        params: {},
        body: {},
      };

      sanitizationMiddleware(mockReq as Request, mockRes as Response, nextFunction);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Bad Request",
        }),
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should allow and sanitize valid payloads and call next()", () => {
      mockReq = {
        query: { filter: "active", page: "1" },
        params: { id: "user_123" },
        body: {
          recipient: "Chukwudi Okafor",
          phone: "+2348012345678",
          amount: 25000,
          currency: "NGN",
          symbol: "₦",
        },
      };

      sanitizationMiddleware(mockReq as Request, mockRes as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });
  });
});
