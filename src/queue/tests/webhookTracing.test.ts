import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  serializeTraceHeaders,
  serializeTraceparent,
  deliverWebhookWithTracing,
} from "../receivingAnchorWebhookWorker";
import {
  ReceivingAnchorWebhookJob,
  WebhookDispatcherService,
} from "../../services/webhookService";
import logger from "../../utils/logger";

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe("Webhook Distributed Tracing (#2504)", () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("serializes W3C traceparent and trace headers when an active context exists", () => {
    const spanContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
    };
    const span = trace.wrapSpanContext(spanContext);
    const ctx = trace.setSpan(context.active(), span);

    const traceHeaders = serializeTraceHeaders(ctx);
    const traceparent = serializeTraceparent(ctx);

    expect(traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(traceHeaders.traceparent).toBe(traceparent);
  });

  it("injects W3C Trace Context headers into outgoing webhook HTTP request dispatch", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    global.fetch = jest
      .fn()
      .mockImplementation(async (url: string, init: any) => {
        capturedUrl = url;
        capturedHeaders = init?.headers;
        return {
          ok: true,
          status: 200,
          text: async () => "OK",
        };
      }) as any;

    const jobData: ReceivingAnchorWebhookJob = {
      callbackUrl: "https://partner.example.com/webhook",
      secret: "super-secret-key-32-bytes-long-1234",
      payload: {
        id: "tx-pay-998877",
        status: "completed",
        amount: "5000",
        stellar_transaction_id: "stellar-tx-hash-112233",
        started_at: new Date().toISOString(),
      },
      _traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };

    const dispatcher = new WebhookDispatcherService();
    await dispatcher.deliver(jobData);

    expect(capturedUrl).toBe("https://partner.example.com/webhook");
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["traceparent"]).toBeDefined();
    // Traceparent preserves the original traceId from the payment request
    expect(capturedHeaders!["traceparent"]).toContain(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(capturedHeaders!["Content-Type"]).toBe("application/json");
    expect(capturedHeaders!["X-Signature"]).toBeDefined();
    expect(capturedHeaders!["X-Signature-Timestamp"]).toBeDefined();
  });

  it("logs trace ID alongside webhook delivery attempt in audit records", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "OK",
    }) as any;

    const jobData: ReceivingAnchorWebhookJob = {
      callbackUrl: "https://partner.example.com/callback",
      secret: "partner-signing-secret-value-1234",
      payload: {
        id: "tx-order-554433",
        status: "completed",
        amount: "15000",
        stellar_transaction_id: "stellar-id-445566",
        started_at: new Date().toISOString(),
      },
      _traceparent: "00-11112222333344445555666677778888-9999000011112222-01",
    };

    const mockDispatcher = {
      deliver: jest.fn().mockResolvedValue(undefined),
    } as unknown as WebhookDispatcherService;

    await deliverWebhookWithTracing(jobData, mockDispatcher);

    expect(mockDispatcher.deliver).toHaveBeenCalledWith(jobData);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "tx-order-554433",
        status: "completed",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        traceparent: expect.stringContaining(
          "11112222333344445555666677778888",
        ),
      }),
      "Receiving-anchor webhook delivery attempt",
    );
  });

  it("allows partner systems to correlate webhook callbacks with initial payment requests across queue trace boundaries", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    global.fetch = jest
      .fn()
      .mockImplementation(async (_url: string, init: any) => {
        capturedHeaders = init?.headers;
        return { ok: true, status: 200, text: async () => "OK" };
      }) as any;

    const initialTraceId = "abcdef0123456789abcdef0123456789";
    const jobData: ReceivingAnchorWebhookJob = {
      callbackUrl: "https://merchant.example.com/notify",
      secret: "merchant-secret-key-1234567890",
      payload: {
        id: "payment-request-1001",
        status: "completed",
        amount: "250",
        stellar_transaction_id: "tx-hash-stellar-999",
        started_at: new Date().toISOString(),
      },
      _traceparent: `00-${initialTraceId}-1234567890abcdef-01`,
      _traceId: initialTraceId,
    };

    const dispatcher = new WebhookDispatcherService();
    await deliverWebhookWithTracing(jobData, dispatcher);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["traceparent"]).toBeDefined();
    // Verify traceId from initial payment request matches the outgoing webhook traceparent
    expect(capturedHeaders!["traceparent"]).toContain(initialTraceId);
  });
});
