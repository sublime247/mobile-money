import { Request, Response, NextFunction } from "express";
import { errorHandler, AppError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

describe("errorHandler middleware - Integration Tests", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn().mockReturnValue(undefined);
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      headers: { "accept-language": "en" },
    };

    mockRes = {
      status: statusMock,
    };

    mockNext = jest.fn();
  });

  describe("Acceptance Criteria 1: Client parsing simplified", () => {
    it("should return consistent error format for all error types", () => {
      const errors: Array<[string, number]> = [
        [ERROR_CODES.INVALID_INPUT, 400],
        [ERROR_CODES.UNAUTHORIZED, 401],
        [ERROR_CODES.FORBIDDEN, 403],
        [ERROR_CODES.NOT_FOUND, 404],
        [ERROR_CODES.CONFLICT, 409],
      ];

      errors.forEach(([code, expectedStatus]) => {
        const error: AppError = new Error("Test error");
        error.code = code;
        error.statusCode = expectedStatus;

        errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

        const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

        // Verify standardized format
        expect(response).toHaveProperty("code");
        expect(response).toHaveProperty("message");
        expect(response).toHaveProperty("message_en");
        expect(response).toHaveProperty("timestamp");
        expect(statusMock).toHaveBeenCalledWith(expectedStatus);
      });
    });

    it("should allow clients to parse errors programmatically by code", () => {
      const error: AppError = new Error("Limit exceeded");
      error.code = ERROR_CODES.LIMIT_EXCEEDED;
      error.statusCode = 429;
      error.details = { dailyLimit: 5000, requested: 10000 };

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];

      // Client can handle errors programmatically
      if (response.code === ERROR_CODES.LIMIT_EXCEEDED) {
        expect(response.details.dailyLimit).toBe(5000);
        expect(response.statusCode).toBe(429);
      }

      expect(response.code).toBe(ERROR_CODES.LIMIT_EXCEEDED);
    });
  });

  describe("Acceptance Criteria 2: User gets native text", () => {
    const testCases = [
      {
        language: "en",
        code: ERROR_CODES.INVALID_PHONE_FORMAT,
        expected: "Phone number format is invalid",
      },
      {
        language: "fr",
        code: ERROR_CODES.INVALID_PHONE_FORMAT,
        expected: "Le format du numéro de téléphone est invalide",
      },
      {
        language: "es",
        code: ERROR_CODES.INVALID_PHONE_FORMAT,
        expected: "El formato del número de teléfono es inválido",
      },
      {
        language: "pt",
        code: ERROR_CODES.INVALID_PHONE_FORMAT,
        expected: "O formato do número de telefone é inválido",
      },
    ];

    testCases.forEach(({ language, code, expected }) => {
      it(`should return localized message for ${language}`, () => {
        mockReq = {
          headers: { "accept-language": language },
        };

        const error: AppError = new Error("Localized error");
        error.code = code;
        error.statusCode = 400;

        errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

        const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

        expect(response.message).toBe(expected);
      });
    });
  });

  describe("Acceptance Criteria 3: Graceful degradation when localization fails", () => {
    it("should fall back to English when an unsupported language is requested", () => {
      mockReq = {
        headers: { "accept-language": "de" }, // German not supported
      };

      const error: AppError = new Error("Unsupported language");
      error.code = ERROR_CODES.INVALID_INPUT;
      error.statusCode = 400;

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

      expect(response.message).toBe("Invalid input provided");
      expect(response.message_en).toBe("Invalid input provided");
    });

    it("should fall back to a generic message when error code is not recognized", () => {
      const error: AppError = new Error("Unknown code");
      error.code = "UNKNOWN_ERROR_CODE";
      error.statusCode = 500;

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

      expect(response.message).toBe("An error occurred");
      expect(response.message_en).toBe("An error occurred");
    });
  });

  describe("Acceptance Criteria 4: Backwards compatibility", () => {
    it("should handle legacy error format gracefully", () => {
      const legacyError: any = new Error("Legacy error");
      legacyError.statusCode = 500;
      legacyError.legacyField = "legacy";

      errorHandler(legacyError, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

      expect(response.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(response.message).toBe("Internal server error");
      expect(response.message_en).toBe("Internal server error");
      expect(response.details.legacyField).toBe("legacy");
    });

    it("should not break when optional fields are missing", () => {
      const partialError: any = new Error("Partial error");
      partialError.statusCode = 400;

      errorHandler(partialError, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

      expect(response.code).toBe(ERROR_CODES.INVALID_INPUT);
      expect(response.message).toBe("Invalid input provided");
      expect(response.message_en).toBe("Invalid input provided");
      expect(response.details).toBeDefined();
    });
  });

  describe("Additional Integration Scenarios", () => {
    it("should respect explicit locale override if provided in error", () => {
      const error: AppError = new Error("Override locale");
      error.code = ERROR_CODES.INVALID_INPUT;
      error.statusCode = 400;
      (error as any).locale = "fr";

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

      expect(response.message).toBe("Entrée invalide fournie");
      expect(response.message_en).toBe("Invalid input provided");
    });

    it("should include request identifier if present on error", () => {
      const error: AppError = new Error("With request ID");
      error.code = ERROR_CODES.INVALID_INPUT;
      error.statusCode = 400;
      (error as any).requestId = "req-123";

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];

      expect(response.requestId).toBe("req-123");
    });
  });
});

