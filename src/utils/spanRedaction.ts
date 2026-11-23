/**
 * Redaction for OpenTelemetry span attributes.
 *
 * Span attributes are exported to a third-party collector, so authorization
 * material and customer phone numbers must never reach them. Redaction works
 * on both the attribute key (reusing the log redaction key list, so
 * `http.request.header.authorization` is dropped wholesale) and the string
 * value (Bearer/Basic credentials and phone numbers embedded in URLs, error
 * messages, etc.).
 */

import type { Attributes, AttributeValue, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { REDACTED, isSensitiveKey } from "./redact";

export const REDACTED_PHONE = "[REDACTED_PHONE]";

// Authorization header values: "Bearer abc", "Basic abc==", "Token abc".
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]+=*/gi;

// Phone numbers: "+256 771 234 567", or 9-15 bare digits that are not part of
// a larger identifier. The lookarounds keep UUID segments, hex ids and
// dash-joined references from being mistaken for a phone number.
const INTL_PHONE_PATTERN = /\+\d[\d\s().-]{6,17}\d/g;
const BARE_PHONE_PATTERN = /(?<![\w.-])\d{9,15}(?![\w-])/g;

export function redactAttributeString(value: string): string {
  return value
    .replace(AUTH_SCHEME_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(INTL_PHONE_PATTERN, REDACTED_PHONE)
    .replace(BARE_PHONE_PATTERN, REDACTED_PHONE);
}

function redactValue(value: AttributeValue): AttributeValue {
  if (typeof value === "string") return redactAttributeString(value);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? redactAttributeString(v) : v)) as AttributeValue;
  }
  return value;
}

/** Returns a copy of `attributes` that is safe to attach to a span. */
export function sanitizeSpanAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
  }
  return out;
}

/**
 * Span processor that scrubs every span just before it is handed to the
 * exporter, so attributes set by auto-instrumentation (http.url, db
 * statements, headers) are covered too, not only the ones we set ourselves.
 * Register it before the exporting processor.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Attributes;
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined) continue;
      attributes[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
    }
    // Exception events carry the error message and stack trace.
    for (const event of span.events) {
      const eventAttrs = event.attributes as Attributes | undefined;
      if (!eventAttrs) continue;
      for (const [key, value] of Object.entries(eventAttrs)) {
        if (value === undefined) continue;
        eventAttrs[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
      }
    }
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
