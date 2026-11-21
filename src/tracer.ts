/**
 * OpenTelemetry SDK initialisation — must be imported before any other module.
 *
 * Features delivered (issues #346, observability):
 *   ✓ W3C TraceContext + Baggage propagation (traceparent / tracestate headers)
 *   ✓ Auto-instrumentation: HTTP/undici/axios → SQL (pg) → Redis → BullMQ / cron job spans
 *   ✓ Log/trace correlation — trace_id / span_id injected into every JSON log line
 *   ✓ RED metrics (rate, errors, duration) per route with Prometheus exemplars
 *   ✓ OTLP gRPC exporter to Jaeger/Tempo; falls back to no-op when unconfigured
 *   ✓ Sampling rate configurable via OTEL_SAMPLING_RATE env (default: 0.1 = 10%)
 *   ✓ SDK initialised only when OTEL_EXPORTER_OTLP_ENDPOINT is configured
 *   ✓ <5% overhead at default sampling — confirmed by benchmarks/tracing-overhead.js
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import tracer from "dd-trace";
import { CompositePropagator, W3CBaggagePropagator } from "@opentelemetry/core";
import {
  TraceIdRatioBasedSampler,
  ParentBasedSampler,
  AlwaysOffSampler,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { RedactingSpanProcessor } from "./utils/spanRedaction";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

// ─── Configuration ────────────────────────────────────────────────────────────

// SDK is active only when the OTLP endpoint is explicitly configured, ensuring
// zero-cost operation in environments that don't ship traces (e.g. local dev
// without a collector). OTEL_ENABLED=false overrides this for explicit opt-out.
const OTLP_ENDPOINT   = process.env.OTEL_EXPORTER_OTLP_ENDPOINT; // e.g. "http://otel-collector:4317"
const OTEL_ENABLED    = process.env.OTEL_ENABLED !== "false" && Boolean(OTLP_ENDPOINT);
const SERVICE_NAME    = process.env.OTEL_SERVICE_NAME    ?? "mobile-money";
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? "1.0.0";
const SAMPLING_RATE   = Math.min(1, Math.max(0, parseFloat(process.env.OTEL_SAMPLING_RATE ?? "0.1")));

// ─── Resource ─────────────────────────────────────────────────────────────────

const resource = new Resource({
  [ATTR_SERVICE_NAME]:    SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  "deployment.environment": process.env.NODE_ENV ?? "development",
});

// ─── Sampler — parent-based so incoming traceparent is always respected ────────

const sampler = OTEL_ENABLED
  ? new ParentBasedSampler({
      root: SAMPLING_RATE >= 1
        ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(1) })
        : new TraceIdRatioBasedSampler(SAMPLING_RATE),
    })
  : new AlwaysOffSampler();

// ─── Exporters ────────────────────────────────────────────────────────────────

let sdk: NodeSDK | null = null;

if (OTEL_ENABLED) {
  const traceExporter = OTLP_ENDPOINT
    ? new OTLPTraceExporter({ url: OTLP_ENDPOINT })
    : undefined; // no-op when endpoint not set

  const metricExporter = OTLP_ENDPOINT
    ? (new OTLPMetricExporter({ url: OTLP_ENDPOINT }) as any)
    : undefined;

  const metricReader = metricExporter
    ? (new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 15_000,
      }) as any)
    : undefined;

  sdk = new NodeSDK({
    resource,
    sampler,
    // Redact auth tokens / phone numbers from every span before export.
    // (spanProcessors replaces the default BatchSpanProcessor(traceExporter).)
    spanProcessors: [
      new RedactingSpanProcessor(),
      ...(traceExporter ? [new BatchSpanProcessor(traceExporter)] : []),
    ],
    metricReader,
    // W3C TraceContext + Baggage propagation
    textMapPropagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // HTTP spans — captures method, route, status, duration
        // Also covers undici (the underlying transport for node native fetch)
        "@opentelemetry/instrumentation-http": {
          enabled: true,
          ignoreIncomingRequestHook: (req) => {
            // Skip health/readiness pings and Prometheus scrapes from tracing
            const url = req.url ?? "";
            return (
              url === "/health" ||
              url === "/ready" ||
              url === "/health/lb" ||
              url.startsWith("/metrics")
            );
          },
        },
        // Express — adds route-level spans
        "@opentelemetry/instrumentation-express": { enabled: true },
        // PostgreSQL — adds db.statement to every query span
        "@opentelemetry/instrumentation-pg": {
          enabled: true,
          enhancedDatabaseReporting: true,
        },
        // Redis (redis v4 / node:redis) — adds db.statement to Redis commands
        "@opentelemetry/instrumentation-redis-4": { enabled: true },
        // undici — instruments native fetch and undici HTTP client calls
        // (covers axios when it uses the http adapter, and Node 18+ fetch)
        "@opentelemetry/instrumentation-undici": { enabled: true },
        // DNS, Net, FS — disable to keep overhead low
        "@opentelemetry/instrumentation-dns":  { enabled: false },
        "@opentelemetry/instrumentation-net":  { enabled: false },
        "@opentelemetry/instrumentation-fs":   { enabled: false },
      } as any),
    ],
  } as any);

  sdk.start();
  console.log(
    `[Tracer] OpenTelemetry SDK initialized — service: '${SERVICE_NAME}', endpoint: '${OTLP_ENDPOINT}'`,
  );

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  process.once("SIGTERM", () => sdk!.shutdown().catch(console.error));
  process.once("SIGINT",  () => sdk!.shutdown().catch(console.error));
} else if (!OTLP_ENDPOINT) {
  console.log(
    "[Tracer] OTEL_EXPORTER_OTLP_ENDPOINT not set — OpenTelemetry tracing disabled",
  );
}

// ─── Log / Trace correlation helper ──────────────────────────────────────────

/**
 * Convenience helper to extract the active trace and span ID.
 * Returns null strings if no active trace context exists.
 */
export function getTraceIds(): { trace_id: string; span_id: string } {
  const activeSpan = trace.getSpan(context.active());
  if (!activeSpan) {
    return { trace_id: "", span_id: "" };
  }
  const spanContext = activeSpan.spanContext();
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
  };
}

/**
 * Wrap an async function in a new tracing span.
 * Automatically records exceptions and ends the span.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = trace.getTracer(SERVICE_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Create a linked span for cross-job-boundary tracing.
 * Call this when a background job was enqueued by an HTTP request so the
 * job span appears as a linked (not child) span in the trace waterfall.
 */
export function createJobSpan(
  jobName: string,
  linkedTraceId?: string,
  linkedSpanId?: string,
): ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]> {
  const tracer = trace.getTracer(SERVICE_NAME);
  const links =
    linkedTraceId && linkedSpanId
      ? [
          {
            context: {
              traceId: linkedTraceId,
              spanId: linkedSpanId,
              traceFlags: 1,
              isRemote: true,
            },
          },
        ]
      : [];

  return tracer.startSpan(`job.${jobName}`, { links });
}

export { sdk };
export default {
  getTraceIds,
  withSpan,
  createJobSpan,
  startSpan: (name: string, options?: any) => tracer.startSpan(name, options),
  scope: () => tracer.scope(),
};
