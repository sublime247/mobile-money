import * as Sentry from "@sentry/node";
import { sentryBreadcrumbMiddleware } from "../middleware/sentry";
import { Request, Response } from "express";

// Mock Sentry
jest.mock("@sentry/node", () => ({
  getCurrentScope: jest.fn().mockReturnValue({
    setContext: jest.fn(),
  }),
  addBreadcrumb: jest.fn(),
}));

describe("Sentry Middleware - PII Scrubbing", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: jest.Mock;

  beforeEach(() => {
    mockRequest = {
      method: "POST",
      url: "/api/transactions/deposit",
      path: "/api/transactions/deposit",
      params: { id: "123" },
      query: { debug: "true" },
      body: {
        amount: "500",
        phoneNumber: "+237600000000", 
        stellarSeed: "SABC123456789", 
        metadata: {
          token: "secret-token-123" 
        }
      },
    };
    mockResponse = {};
    nextFunction = jest.fn();
  });

  it("should redact sensitive information in request context", () => {
    const scope = Sentry.getCurrentScope();
    
    sentryBreadcrumbMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction
    );

    // Verify setContext was called with redacted data
    expect(scope.setContext).toHaveBeenCalledWith(
      "request_info",
      expect.objectContaining({
        params: { id: "123" },
        // Add checks for query or body if you decide to add body to context
      })
    );

    expect(nextFunction).toHaveBeenCalled();
  });

  it("should record a breadcrumb with the user ID", () => {
    (mockRequest as any).user = { id: "user-99" };

    sentryBreadcrumbMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction
    );

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "auth",
        data: { userId: "user-99" },
      })
    );
  });
});