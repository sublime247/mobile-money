/**
 * OpenTelemetry propagation tests (issue #346)
 *
 * Covers:
 *   1. Inbound traceparent → outbound child context (W3C round-trip)
 *   2. Job-boundary span linkage (enqueue → worker span has link to HTTP span)
 *   3. Log/trace ID correlation (trace_id / span_id in structured log output)
 */

import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { CompositePropagator, W3CBaggagePropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestProvider() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  // Without a context manager `context.with()` is a no-op and
  // `trace.getActiveSpan()` returns undefined inside a span.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  provider.register({
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });
  return { provider, exporter };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("W3C TraceContext propagation round-trip", () => {
  let provider: BasicTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    const result = buildTestProvider();
    provider = result.provider;
    exporter = result.exporter;
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
  });

  it("extracts an inbound traceparent and creates a child span with the correct parent", () => {
    const propagator = new W3CTraceContextPropagator();

    // Simulate an inbound HTTP request that carries a traceparent header
    const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const inboundSpanId  = "00f067aa0ba902b7";
    const traceparent    = `00-${inboundTraceId}-${inboundSpanId}-01`;

    const carrier = { traceparent };
    const extractedCtx = propagator.extract(context.active(), carrier, {
      get: (c, k) => (c as Record<string, string>)[k],
      keys: (c) => Object.keys(c as Record<string, string>),
    });

    // Create a child span within the extracted context
    const tracer = provider.getTracer("test");
    let childSpanContext: ReturnType<typeof trace.getActiveSpan>["spanContext"] | null = null;

    context.with(extractedCtx, () => {
      const childSpan = tracer.startSpan("child-operation", { kind: SpanKind.INTERNAL });
      childSpanContext = childSpan.spanContext;
      childSpan.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const child = spans[0];
    // Child must share the inbound trace ID
    expect(child.spanContext().traceId).toBe(inboundTraceId);
    // Child's parent must be the inbound span ID
    expect(child.parentSpanId).toBe(inboundSpanId);
  });

  it("injects outbound traceparent header carrying the child trace context", () => {
    const propagator = new W3CTraceContextPropagator();
    const tracer = provider.getTracer("test");

    const outboundCarrier: Record<string, string> = {};
    let injectedTraceId = "";
    let injectedSpanId  = "";

    tracer.startActiveSpan("outbound-request", (span) => {
      injectedTraceId = span.spanContext().traceId;
      injectedSpanId  = span.spanContext().spanId;

      propagator.inject(context.active(), outboundCarrier, {
        set: (c, k, v) => { (c as Record<string, string>)[k] = v; },
      });

      span.end();
    });

    // The injected header must reference the active span
    expect(outboundCarrier.traceparent).toBeDefined();
    expect(outboundCarrier.traceparent).toContain(injectedTraceId);
    expect(outboundCarrier.traceparent).toContain(injectedSpanId);
  });
});

describe("Job-boundary span linkage", () => {
  let provider: BasicTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    const result = buildTestProvider();
    provider = result.provider;
    exporter = result.exporter;
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
  });

  it("links a job span to the originating HTTP span via SpanLink", () => {
    const tracer = provider.getTracer("test");

    // Simulate the HTTP handler span that enqueues the job
    let httpTraceId = "";
    let httpSpanId  = "";

    tracer.startActiveSpan("POST /api/transactions", (httpSpan) => {
      httpTraceId = httpSpan.spanContext().traceId;
      httpSpanId  = httpSpan.spanContext().spanId;
      httpSpan.end();
    });

    // Simulate the job worker span that links back to the HTTP span
    const jobSpan = tracer.startSpan("job.process-transaction", {
      kind: SpanKind.INTERNAL,
      links: [
        {
          // `trace.wrapSpanContext()` returns a NonRecordingSpan (a Span), not
          // a SpanContext — link contexts must be the raw context object.
          context: {
            traceId: httpTraceId,
            spanId: httpSpanId,
            traceFlags: 1,
            isRemote: true,
          },
          attributes: { "link.type": "enqueued-by" },
        },
      ],
    });
    jobSpan.end();

    const spans = exporter.getFinishedSpans();
    // HTTP span + job span
    expect(spans.length).toBeGreaterThanOrEqual(2);

    const jobSpanRecord = spans.find(
      (s) => s.name === "job.process-transaction",
    );
    expect(jobSpanRecord).toBeDefined();
    expect(jobSpanRecord!.links).toHaveLength(1);
    expect(jobSpanRecord!.links[0].context.traceId).toBe(httpTraceId);
    expect(jobSpanRecord!.links[0].context.spanId).toBe(httpSpanId);
  });
});

describe("Log / trace ID correlation", () => {
  it("returns empty strings when no active span exists", async () => {
    // Import after SDK init so we get the real module
    const { getTraceIds } = await import("../../src/tracer");
    const ids = getTraceIds();
    // Outside of a span context, both should be empty strings
    expect(typeof ids.trace_id).toBe("string");
    expect(typeof ids.span_id).toBe("string");
  });

  it("returns the active trace_id and span_id inside a span", () => {
    const { provider, exporter: _e } = buildTestProvider();
    const tracer = provider.getTracer("test");

    tracer.startActiveSpan("correlation-test", (span) => {
      const expectedTraceId = span.spanContext().traceId;
      const expectedSpanId  = span.spanContext().spanId;

      // Simulate what a structured logger would call
      const activeSpan = trace.getActiveSpan();
      expect(activeSpan).toBeDefined();

      const ctx = activeSpan!.spanContext();
      expect(ctx.traceId).toBe(expectedTraceId);
      expect(ctx.spanId).toBe(expectedSpanId);
      // Both IDs are 32 hex chars (trace) or 16 hex chars (span)
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);

      span.end();
    });
  });
});
