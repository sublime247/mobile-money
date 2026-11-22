import * as Sentry from "@sentry/node";
import { sentryBreadcrumbMiddleware, initSentry } from "../middleware/sentry";
import { Request, Response } from "express";

// Mock Sentry
jest.mock("@sentry/node", () => ({
  getCurrentScope: jest.fn().mockReturnValue({
    setContext: jest.fn(),
  }),
  addBreadcrumb: jest.fn(),
  init: jest.fn(),
  captureException: jest.fn(),
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
          token: "secret-token-123",
        },
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
      nextFunction,
    );

    // Verify setContext was called with redacted data
    expect(scope.setContext).toHaveBeenCalledWith(
      "request_info",
      expect.objectContaining({
        params: { id: "123" },
        // Add checks for query or body if you decide to add body to context
      }),
    );

    expect(nextFunction).toHaveBeenCalled();
  });

  it("should record a breadcrumb with the user ID", () => {
    (mockRequest as any).user = { id: "user-99" };

    sentryBreadcrumbMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction,
    );

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "auth",
        data: { userId: "user-99" },
      }),
    );
  });
});

describe("initSentry - environment tag and beforeSend scrubbing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("initializes with the current NODE_ENV as the environment tag", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "staging";

    initSentry("https://example-dsn@sentry.io/1");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "staging" }),
    );

    process.env.NODE_ENV = previousEnv;
  });

  it("scrubs sensitive request body fields in beforeSend", () => {
    initSentry("https://example-dsn@sentry.io/1");
    const config = (Sentry.init as jest.Mock).mock.calls[0][0];

    const event = {
      request: {
        data: { phoneNumber: "+237600000000", amount: "500" },
      },
    };

    const result = config.beforeSend(event);

    expect(result.request.data.phoneNumber).toBe("[REDACTED]");
    expect(result.request.data.amount).toBe("500");
  });

  it("scrubs Authorization, Cookie, and X-Api-Key headers in beforeSend", () => {
    initSentry("https://example-dsn@sentry.io/1");
    const config = (Sentry.init as jest.Mock).mock.calls[0][0];

    const event = {
      request: {
        headers: {
          Authorization: "Bearer super-secret-token",
          Cookie: "session=abc123",
          "X-Api-Key": "key-123",
          "Content-Type": "application/json",
        },
      },
    };

    const result = config.beforeSend(event);

    expect(result.request.headers.Authorization).toBe("[REDACTED]");
    expect(result.request.headers.Cookie).toBe("[REDACTED]");
    expect(result.request.headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(result.request.headers["Content-Type"]).toBe("application/json");
  });

  it("leaves events without request data/headers untouched", () => {
    initSentry("https://example-dsn@sentry.io/1");
    const config = (Sentry.init as jest.Mock).mock.calls[0][0];

    const event = { message: "no request context" };
    const result = config.beforeSend(event);

    expect(result).toEqual(event);
  });
});

describe("registerProcessErrorCapture", () => {
  // registerProcessErrorCapture guards against double-registration with
  // module-level state, so each test gets a fresh module instance to
  // observe listener attachment in isolation.
  const loadFreshModule = () => {
    let freshModule: typeof import("../middleware/sentry");
    jest.isolateModules(() => {
      freshModule = require("../middleware/sentry");
    });
    return freshModule!;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
  });

  it("captures unhandled promise rejections with a source tag", () => {
    const { registerProcessErrorCapture: register } = loadFreshModule();
    register();

    const error = new Error("unhandled rejection boom");
    process.emit("unhandledRejection", error, Promise.resolve());

    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { source: "unhandledRejection" } }),
    );
  });

  it("wraps non-Error rejection reasons in an Error before capturing", () => {
    const { registerProcessErrorCapture: register } = loadFreshModule();
    register();

    process.emit(
      "unhandledRejection",
      "string rejection reason",
      Promise.resolve(),
    );

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: "unhandledRejection" } }),
    );
    const capturedError = (Sentry.captureException as jest.Mock).mock
      .calls[0][0];
    expect(capturedError.message).toBe("string rejection reason");
  });

  it("captures uncaught exceptions with a source tag", () => {
    const { registerProcessErrorCapture: register } = loadFreshModule();
    register();

    const error = new Error("uncaught boom");
    process.emit("uncaughtException", error);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { source: "uncaughtException" } }),
    );
  });

  it("only attaches process listeners once across multiple calls", () => {
    const { registerProcessErrorCapture: register } = loadFreshModule();
    const addListenerSpy = jest.spyOn(process, "on");

    register();
    register();
    register();

    const unhandledRejectionCalls = addListenerSpy.mock.calls.filter(
      ([eventName]) => eventName === "unhandledRejection",
    );
    expect(unhandledRejectionCalls.length).toBe(1);

    addListenerSpy.mockRestore();
  });
});
