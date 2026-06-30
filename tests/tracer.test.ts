import type tracer from "dd-trace";

describe("Datadog Tracer initialisation", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function mockTracer() {
    const initMock = jest.fn();
    const useMock = jest.fn().mockReturnThis();
    jest.doMock("dd-trace", () => {
      const mock = { init: initMock, use: useMock } as unknown as typeof tracer;
      (mock as any).default = mock;
      return mock;
    });
    return { initMock, useMock };
  }

  function graphqlConfig(useMock: jest.Mock) {
    return useMock.mock.calls.find(([name]: string) => name === "graphql")?.[1];
  }

  it("calls tracer.init with env from NODE_ENV", () => {
    process.env.NODE_ENV = "production";

    const { initMock, useMock } = mockTracer();
    require("../src/tracer");

    expect(initMock).toHaveBeenCalledWith({
      logInjection: true,
      env: "production",
      service: "mobile-money",
    });

    const gql = graphqlConfig(useMock);
    expect(gql).toBeDefined();
    expect(gql.depth).toBe(-1);
    expect(gql.signature).toBe(true);
    expect(gql.source).toBe(false);
    expect(typeof gql.variables).toBe("function");
    expect(typeof gql.hooks?.execute).toBe("function");
  });

  it("falls back to 'development' when NODE_ENV is not set", () => {
    delete process.env.NODE_ENV;

    const { initMock, useMock } = mockTracer();
    require("../src/tracer");

    expect(initMock).toHaveBeenCalledWith({
      logInjection: true,
      env: "development",
      service: "mobile-money",
    });

    const gql = graphqlConfig(useMock);
    expect(gql).toBeDefined();
    expect(gql.depth).toBe(-1);
    expect(gql.signature).toBe(true);
    expect(gql.source).toBe(false);
    expect(typeof gql.variables).toBe("function");
    expect(typeof gql.hooks?.execute).toBe("function");
  });

  it("sanitizes PII in graphql variables", () => {
    process.env.NODE_ENV = "test";

    const { useMock } = mockTracer();
    require("../src/tracer");

    const gql = graphqlConfig(useMock);
    const sanitize: (vars: Record<string, unknown>) => Record<string, unknown> =
      gql.variables;

    expect(sanitize({ phoneNumber: "+1234567890" })).toEqual({
      phoneNumber: "***",
    });
    expect(sanitize({ address: "123 Main St" })).toEqual({ address: "***" });
    expect(sanitize({ token: "abc123" })).toEqual({ token: "***" });
    expect(sanitize({ secret: "s3cr3t" })).toEqual({ secret: "***" });
    expect(sanitize({ password: "hunter2" })).toEqual({ password: "***" });
    expect(sanitize({ apiKey: "some-key" })).toEqual({ apiKey: "***" });
    expect(sanitize({ amount: "100" })).toEqual({ amount: "100" });
    expect(sanitize({ limit: 50 })).toEqual({ limit: 50 });
    expect(sanitize(null as unknown as Record<string, unknown>)).toBeNull();
  });

  it("tags execute span with operation type and name", () => {
    process.env.NODE_ENV = "test";

    const { useMock } = mockTracer();
    require("../src/tracer");

    const gql = graphqlConfig(useMock);
    const hook = gql.hooks.execute;

    const setTag = jest.fn();
    const span = { setTag };
    const args = {
      document: {
        definitions: [
          {
            kind: "OperationDefinition",
            operation: "query",
            name: { value: "GetTransaction" },
          },
        ],
      },
    };

    hook(span, args);
    expect(setTag).toHaveBeenCalledWith("graphql.operation.type", "query");
    expect(setTag).toHaveBeenCalledWith(
      "graphql.operation.name",
      "GetTransaction",
    );
  });

  it("skips tagging when span or args is missing", () => {
    process.env.NODE_ENV = "test";

    const { useMock } = mockTracer();
    require("../src/tracer");

    const gql = graphqlConfig(useMock);
    const hook = gql.hooks.execute;

    const setTag = jest.fn();
    expect(() => hook(null, null)).not.toThrow();
    expect(() => hook({ setTag }, null)).not.toThrow();
    expect(setTag).not.toHaveBeenCalled();
  });

  it("handles anonymous operations without a name", () => {
    process.env.NODE_ENV = "test";

    const { useMock } = mockTracer();
    require("../src/tracer");

    const gql = graphqlConfig(useMock);
    const hook = gql.hooks.execute;

    const setTag = jest.fn();
    const span = { setTag };
    const args = {
      document: {
        definitions: [
          {
            kind: "OperationDefinition",
            operation: "mutation",
          },
        ],
      },
    };

    hook(span, args);
    expect(setTag).toHaveBeenCalledWith("graphql.operation.type", "mutation");
    expect(setTag).not.toHaveBeenCalledWith(
      "graphql.operation.name",
      expect.anything(),
    );
  });
});
