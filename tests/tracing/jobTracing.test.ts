/**
 * Queue-boundary OpenTelemetry propagation tests.
 *
 * Covers the HTTP → enqueue → worker link added by src/queue/jobTracing.ts:
 *   1. traceparent injection while the HTTP span is active
 *   2. round-trip: the worker span continues the producer's trace
 *   3. legacy _traceId handling (only filled when the producer left it unset)
 *   4. error recording / rethrow so queue retry semantics are preserved
 */

import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  injectTraceContext,
  extractTraceContext,
  withJobTrace,
  TRACEPARENT_KEY,
} from "../../src/queue/jobTracing";
import { TRACE_ID_KEY } from "../../src/queue/trace";

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

  // Registered once per test file: context propagation and the global
  // propagator are process-wide singletons in the OTel API.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  provider.register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });
});

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

function findSpan(name: string): ReadableSpan | undefined {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

describe("injectTraceContext", () => {
  it("embeds a W3C traceparent for the active span", () => {
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("http.request", (span) => {
      const { traceId, spanId } = span.spanContext();
      const data = injectTraceContext({ transactionId: "tx-1" });

      expect(data._traceparent).toMatch(TRACEPARENT_PATTERN);
      expect(String(data._traceparent)).toContain(traceId);
      expect(String(data._traceparent)).toContain(spanId);
      // No explicit correlation id was provided → fall back to the OTel id
      expect(data[TRACE_ID_KEY]).toBe(traceId);

      span.end();
    });
  });

  it("keeps a producer-supplied _traceId untouched", () => {
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("http.request", (span) => {
      const data = injectTraceContext({
        transactionId: "tx-2",
        [TRACE_ID_KEY]: "producer-correlation-uuid",
      });

      expect(data[TRACE_ID_KEY]).toBe("producer-correlation-uuid");
      expect(data._traceparent).toMatch(TRACEPARENT_PATTERN);
      span.end();
    });
  });

  it("returns the payload unchanged when there is no active span", () => {
    const payload = { transactionId: "tx-3" };
    const data = injectTraceContext(payload);

    expect(data).toEqual(payload);
    expect(data._traceparent).toBeUndefined();
  });
});

describe("withJobTrace", () => {
  it("continues the producer's trace across the queue boundary", async () => {
    const tracer = trace.getTracer("test");

    let producerTraceId = "";
    let producerSpanId = "";
    let jobData: Record<string, unknown> = {};

    tracer.startActiveSpan("http.request", (span) => {
      producerTraceId = span.spanContext().traceId;
      producerSpanId = span.spanContext().spanId;
      jobData = injectTraceContext({ transactionId: "tx-4" });
      span.end();
    });

    let workerTraceId = "";
    await withJobTrace("queue.transaction.process", jobData, async () => {
      const active = trace.getActiveSpan();
      workerTraceId = active?.spanContext().traceId ?? "";
      expect(active?.spanContext().traceId).toBe(producerTraceId);
      return "ok";
    });

    expect(workerTraceId).toBe(producerTraceId);

    const workerSpan = findSpan("queue.transaction.process");
    expect(workerSpan).toBeDefined();
    expect(workerSpan!.spanContext().traceId).toBe(producerTraceId);
    expect(workerSpan!.parentSpanId).toBe(producerSpanId);
    expect(workerSpan!.kind).toBe(SpanKind.CONSUMER);
    expect(workerSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it("records job attributes and the remote parent link", async () => {
    const tracer = trace.getTracer("test");
    let jobData: Record<string, unknown> = {};

    tracer.startActiveSpan("http.request", (span) => {
      jobData = injectTraceContext({ transactionId: "tx-5" });
      span.end();
    });

    await withJobTrace(
      "queue.sync.process",
      jobData,
      async () => undefined,
      { "messaging.system": "bullmq", "transaction.id": "tx-5" },
    );

    const span = findSpan("queue.sync.process");
    expect(span!.attributes["messaging.system"]).toBe("bullmq");
    expect(span!.attributes["transaction.id"]).toBe("tx-5");
  });

  it("starts a root span when no traceparent was propagated", async () => {
    await withJobTrace(
      "scheduler.reconciliation",
      undefined,
      async () => undefined,
      { "job.name": "reconciliation" },
    );

    const span = findSpan("scheduler.reconciliation");
    expect(span).toBeDefined();
    expect(span!.parentSpanId).toBeUndefined();
    expect(span!.attributes["job.name"]).toBe("reconciliation");
  });

  it("records the exception, marks the span as error and rethrows", async () => {
    const failure = new Error("provider exploded");

    await expect(
      withJobTrace("queue.transaction.process", {}, async () => {
        throw failure;
      }),
    ).rejects.toThrow("provider exploded");

    const span = findSpan("queue.transaction.process");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe("provider exploded");
    expect(span!.events.map((e) => e.name)).toContain("exception");
  });
});

describe("extractTraceContext", () => {
  it("falls back to the active context without job data", () => {
    expect(() => extractTraceContext(undefined)).not.toThrow();
    expect(() => extractTraceContext({})).not.toThrow();
    expect(() =>
      extractTraceContext({ [TRACEPARENT_KEY]: "not-a-traceparent" }),
    ).not.toThrow();
  });

  it("restores the remote parent from a serialized traceparent", async () => {
    const tracer = trace.getTracer("test");
    let jobData: Record<string, unknown> = {};

    tracer.startActiveSpan("http.request", (span) => {
      jobData = injectTraceContext({ transactionId: "tx-6" });
      span.end();
    });
    exporter.reset();

    const remoteContext = extractTraceContext(jobData);
    let childTraceId = "";
    await context.with(remoteContext, async () => {
      const span = tracer.startSpan("child");
      childTraceId = span.spanContext().traceId;
      span.end();
    });

    expect(childTraceId).toBe(
      String(jobData[TRACEPARENT_KEY]).split("-")[1],
    );
  });
});
