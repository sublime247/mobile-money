import { AsyncLocalStorage } from "node:async_hooks";
import { context, ROOT_CONTEXT, trace, Context, ContextManager } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  recordTelcoHttpStatus,
  resolveTelcoCountry,
  withTelcoSpan,
} from "../telcoTracing";
import {
  RedactingSpanProcessor,
  redactAttributeString,
  sanitizeSpanAttributes,
} from "../spanRedaction";

// Minimal AsyncLocalStorage context manager so startActiveSpan propagates.
class AlsContextManager implements ContextManager {
  private als = new AsyncLocalStorage<Context>();
  active(): Context { return this.als.getStore() ?? ROOT_CONTEXT; }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A
  ): ReturnType<F> {
    return this.als.run(ctx, () => fn.call(thisArg as never, ...args));
  }
  bind<T>(_ctx: Context, target: T): T { return target; }
  enable(): this { return this; }
  disable(): this { this.als.disable(); return this; }
}

describe("spanRedaction", () => {
  it("redacts bearer tokens and phone numbers in strings", () => {
    expect(redactAttributeString("Bearer abc.def-123")).toBe("Bearer [REDACTED]");
    expect(redactAttributeString("GET /msisdn/256771234567/balance")).toBe(
      "GET /msisdn/[REDACTED_PHONE]/balance",
    );
    expect(redactAttributeString("call +256 771 234 567 now")).toBe("call [REDACTED_PHONE] now");
  });

  it("leaves UUIDs and telco attributes alone", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(redactAttributeString(uuid)).toBe(uuid);
    const out = sanitizeSpanAttributes({
      "telco.provider": "mtn",
      "telco.country": "UG",
      "telco.status_code": 200,
      "telco.duration_ms": 123,
    });
    expect(out).toEqual({
      "telco.provider": "mtn",
      "telco.country": "UG",
      "telco.status_code": 200,
      "telco.duration_ms": 123,
    });
  });

  it("drops values of sensitive keys", () => {
    expect(sanitizeSpanAttributes({ "http.request.header.authorization": "Bearer x" })).toEqual({
      "http.request.header.authorization": "[REDACTED]",
    });
  });
});

describe("resolveTelcoCountry", () => {
  it("prefers the provider's country, then the dialling code", () => {
    expect(resolveTelcoCountry("mtnRwanda")).toBe("RW");
    expect(resolveTelcoCountry("mtn", "+256771234567")).toBe("UG");
    expect(resolveTelcoCountry("mtn")).toBeUndefined();
  });
});

describe("withTelcoSpan", () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    context.setGlobalContextManager(new AlsContextManager());
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new RedactingSpanProcessor());
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    trace.setGlobalTracerProvider(provider);
  });
  beforeEach(() => exporter.reset());

  it("sets provider, country, status code and duration without the phone number", async () => {
    await withTelcoSpan(
      { provider: "mtn", operation: "sendPayout", phoneNumber: "+256771234567" },
      async () => {
        recordTelcoHttpStatus(202);
        return { success: true };
      },
    );

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["telco.provider"]).toBe("mtn");
    expect(span.attributes["telco.country"]).toBe("UG");
    expect(span.attributes["telco.status_code"]).toBe(202);
    expect(typeof span.attributes["telco.duration_ms"]).toBe("number");
    expect(JSON.stringify(span.attributes)).not.toContain("771234567");
  });

  it("falls back to the status on the thrown error and still records duration", async () => {
    await expect(
      withTelcoSpan({ provider: "mtn", operation: "initiatePayment" }, async () => {
        throw Object.assign(new Error("failed for 256771234567"), { response: { status: 503 } });
      }),
    ).rejects.toThrow();

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["telco.status_code"]).toBe(503);
    expect(span.attributes["telco.duration_ms"]).toBeDefined();
    expect(JSON.stringify(span.events)).not.toContain("256771234567");
  });
});
