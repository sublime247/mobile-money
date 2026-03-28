describe("Datadog Tracer initialisation", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("calls tracer.init with env from NODE_ENV", () => {
    process.env.NODE_ENV = "production";

    const initMock = jest.fn();
    // The compiled CJS import looks for module.default or module itself
    jest.doMock("dd-trace", () => {
      const mockTracer = { init: initMock };
      // Support both `import tracer from 'dd-trace'` styles
      (mockTracer as any).default = mockTracer;
      return mockTracer;
    });

    require("../src/tracer");

    expect(initMock).toHaveBeenCalledWith({
      logInjection: true,
      env: "production",
      service: "mobile-money",
    });
  });

  it("falls back to 'development' when NODE_ENV is not set", () => {
    delete process.env.NODE_ENV;

    const initMock = jest.fn();
    jest.doMock("dd-trace", () => {
      const mockTracer = { init: initMock };
      (mockTracer as any).default = mockTracer;
      return mockTracer;
    });

    require("../src/tracer");

    expect(initMock).toHaveBeenCalledWith({
      logInjection: true,
      env: "development",
      service: "mobile-money",
    });
  });
});
