/**
 * OpenTelemetry tracer bootstrap tests (src/tracer.ts).
 *
 * The SDK is never really started here: `tests/jest.setup.ts` defaults
 * OTEL_ENABLED=false and the startup path is exercised with a mocked
 * `@opentelemetry/sdk-node`, so no HTTP/DB globals get patched in-process.
 */

import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { CompositePropagator } from "@opentelemetry/core";

describe("OpenTelemetry tracer bootstrap", () => {
  const ORIGINAL_ENV = process.env;
  const nodeSdkMock = jest.fn();
  const sdkInstance = { start: jest.fn(), shutdown: jest.fn() };
  const getNodeAutoInstrumentationsMock = jest.fn(() => [
    "instrumentation-set",
  ]);
  const otlpTraceExporterMock = jest.fn();
  const otlpMetricExporterMock = jest.fn();
  const ddTraceMock = {
    startSpan: jest.fn(),
    scope: jest.fn(),
    __esModule: true,
    default: undefined as unknown,
  };
  ddTraceMock.default = ddTraceMock;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    nodeSdkMock.mockClear();
    sdkInstance.start.mockClear();
    getNodeAutoInstrumentationsMock.mockClear();
    otlpTraceExporterMock.mockClear();
    otlpMetricExporterMock.mockClear();

    jest.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: nodeSdkMock,
    }));
    jest.doMock("@opentelemetry/auto-instrumentations-node", () => ({
      getNodeAutoInstrumentations: getNodeAutoInstrumentationsMock,
    }));
    jest.doMock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
      OTLPTraceExporter: otlpTraceExporterMock,
    }));
    jest.doMock("@opentelemetry/exporter-metrics-otlp-grpc", () => ({
      OTLPMetricExporter: otlpMetricExporterMock,
    }));
    jest.doMock("dd-trace", () => ddTraceMock);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it("does not start the SDK when OTEL_ENABLED=false", () => {
    process.env.OTEL_ENABLED = "false";

    const tracer = require("../src/tracer");

    expect(nodeSdkMock).not.toHaveBeenCalled();
    expect(sdkInstance.start).not.toHaveBeenCalled();
    expect(tracer.sdk).toBeNull();
  });

  it("starts an instrumented SDK with W3C propagation by default", () => {
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://jaeger:4317";
    process.env.OTEL_SERVICE_NAME = "unit-test-service";
    process.env.OTEL_SERVICE_VERSION = "9.9.9";

    nodeSdkMock.mockImplementation(() => sdkInstance);
    const tracer = require("../src/tracer");

    expect(nodeSdkMock).toHaveBeenCalledTimes(1);
    expect(sdkInstance.start).toHaveBeenCalledTimes(1);

    const config = nodeSdkMock.mock.calls[0][0];
    // Compared by name: jest.resetModules() gives tracer.ts its own copy of
    // @opentelemetry/core, so instanceof against this file's copy would fail.
    expect(config.textMapPropagator.constructor.name).toBe(
      "CompositePropagator",
    );
    expect(config.traceExporter).toBeDefined();
    expect(otlpTraceExporterMock).toHaveBeenCalledWith({
      url: "http://jaeger:4317",
    });

    // Resource carries the service identity used to filter traces in Jaeger
    const resourceAttributes = config.resource.attributes;
    expect(resourceAttributes["service.name"]).toBe("unit-test-service");
    expect(resourceAttributes["service.version"]).toBe("9.9.9");

    // Health and metrics endpoints must stay out of the trace waterfall
    const instrumentations = getNodeAutoInstrumentationsMock.mock.calls[0][0];
    const httpConfig = instrumentations["@opentelemetry/instrumentation-http"];
    expect(httpConfig.enabled).toBe(true);
    expect(httpConfig.ignoreIncomingRequestHook({ url: "/health" })).toBe(true);
    expect(httpConfig.ignoreIncomingRequestHook({ url: "/metrics" })).toBe(
      true,
    );
    expect(httpConfig.ignoreIncomingRequestHook({ url: "/api/transactions" })).toBe(
      false,
    );

    expect(tracer.sdk).toBe(sdkInstance);
  });

  it("keeps the SDK no-op when no OTLP endpoint is configured", () => {
    process.env.OTEL_ENABLED = "true";
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    nodeSdkMock.mockImplementation(() => sdkInstance);

    require("../src/tracer");

    const config = nodeSdkMock.mock.calls[0][0];
    expect(config.traceExporter).toBeUndefined();
    expect(otlpTraceExporterMock).not.toHaveBeenCalled();
    expect(sdkInstance.start).toHaveBeenCalledTimes(1);
  });
});

describe("tracer helpers", () => {
  let provider: BasicTracerProvider;
  let exporter: InMemorySpanExporter;
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    process.env.OTEL_ENABLED = "false";
    jest.resetModules();
    jest.doMock("dd-trace", () => ({
      __esModule: true,
      default: { startSpan: jest.fn(), scope: jest.fn() },
    }));

    provider = new BasicTracerProvider();
    exporter = new InMemorySpanExporter();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager);
    provider.register({
      propagator: new CompositePropagator({ propagators: [] }),
    });
  });

  afterAll(async () => {
    await provider.shutdown();
    jest.resetModules();
    jest.dontMock("dd-trace");
  });

  it("returns empty trace ids outside of any span", () => {
    const { getTraceIds } = require("../src/tracer");
    expect(getTraceIds()).toEqual({ trace_id: "", span_id: "" });
  });

  it("withSpan returns the result and exposes the active span ids", async () => {
    const { withSpan, getTraceIds } = require("../src/tracer");

    const ids = await withSpan(
      "unit.operation",
      async () => {
        const active = getTraceIds();
        expect(active.trace_id).toMatch(/^[0-9a-f]{32}$/);
        expect(active.span_id).toMatch(/^[0-9a-f]{16}$/);
        return "done";
      },
      { "unit.test": true },
    );

    expect(ids).toBe("done");
  });

  it("withSpan records the exception, marks it as an error and rethrows", async () => {
    const { withSpan } = require("../src/tracer");

    await expect(
      withSpan("unit.failing", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("createJobSpan links back to the originating trace", async () => {
    const { createJobSpan } = require("../src/tracer");
    const tracer = trace.getTracer("test");
    exporter.reset();

    let traceId = "";
    let spanId = "";
    tracer.startActiveSpan("http.request", (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      span.end();
    });

    const jobSpan = createJobSpan("transaction-process", traceId, spanId);
    // Deliberately a *linked* span: it starts a new trace that references the
    // HTTP trace instead of nesting under it.
    expect(jobSpan.spanContext().traceId).not.toBe(traceId);
    jobSpan.end();

    const exported = exporter
      .getFinishedSpans()
      .find((s) => s.name === "job.transaction-process");
    expect(exported).toBeDefined();
    expect(exported!.links).toHaveLength(1);
    expect(exported!.links[0].context.traceId).toBe(traceId);
    expect(exported!.links[0].context.spanId).toBe(spanId);
  });
});
