/**
 * Telco (mobile money provider) span enrichment.
 *
 * Wraps an outgoing provider operation in a CLIENT span carrying:
 *   telco.provider     provider key, e.g. "mtn"
 *   telco.country      ISO 3166-1 alpha-2 country code, when known
 *   telco.status_code  HTTP status returned by the telco API
 *   telco.duration_ms  wall-clock time of the telco call
 *
 * The span is created with startActiveSpan, so when the call is made from a
 * BullMQ worker running inside `withJobTrace` (see queue/jobTracing.ts) it is
 * a child of the job span, which in turn continues the producer's trace.
 *
 * Phone numbers are only used locally to infer the country from the dialling
 * code; they are never written to the span. Authorization headers are never
 * read. Every attribute goes through sanitizeSpanAttributes as a safety net.
 */

import {
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { AxiosInstance, AxiosResponse } from "axios";
import { sanitizeSpanAttributes } from "./spanRedaction";

const TELCO_TRACER_NAME = "mobile-money.telco";

export const TELCO_ATTR = {
  PROVIDER: "telco.provider",
  COUNTRY: "telco.country",
  STATUS_CODE: "telco.status_code",
  DURATION_MS: "telco.duration_ms",
} as const;

/** Provider keys that belong to exactly one country. */
const PROVIDER_COUNTRY: Record<string, string> = {
  mtnrwanda: "RW",
  vodafoneghana: "GH",
  wavesenegal: "SN",
  orangeguinea: "GN",
  orangemadagascar: "MG",
  mpesa: "KE",
  vodacom: "TZ",
  tigo: "TZ",
  ecocash: "ZW",
};

/** Dialling code -> country, longest prefix wins. */
const DIAL_CODE_COUNTRY: Array<[string, string]> = [
  ["221", "SN"], ["224", "GN"], ["225", "CI"], ["233", "GH"], ["234", "NG"],
  ["237", "CM"], ["243", "CD"], ["250", "RW"], ["254", "KE"], ["255", "TZ"],
  ["256", "UG"], ["260", "ZM"], ["261", "MG"], ["263", "ZW"],
];

export function resolveTelcoCountry(
  providerKey: string,
  phoneNumber?: string,
): string | undefined {
  const byProvider = PROVIDER_COUNTRY[providerKey.toLowerCase()];
  if (byProvider) return byProvider;
  if (!phoneNumber) return undefined;
  const digits = phoneNumber.replace(/\D/g, "");
  return DIAL_CODE_COUNTRY.find(([code]) => digits.startsWith(code))?.[1];
}

/** Spans created by withTelcoSpan, so HTTP hooks only annotate those. */
const telcoSpans = new WeakMap<Span, { statusCode?: number }>();

/** Records the HTTP status returned by the telco on the active telco span. */
export function recordTelcoHttpStatus(statusCode: number | undefined): void {
  if (statusCode === undefined || !Number.isFinite(statusCode)) return;
  const span = trace.getActiveSpan();
  const state = span && telcoSpans.get(span);
  if (!span || !state) return;
  state.statusCode = statusCode;
  span.setAttributes(sanitizeSpanAttributes({ [TELCO_ATTR.STATUS_CODE]: statusCode }));
}

/**
 * Axios interceptors that report the telco's HTTP status (success or error)
 * to the active telco span. Attach to each provider client instance, and to
 * the default axios export.
 */
export function attachTelcoTracingInterceptor(client: AxiosInstance): void {
  // Some tests replace axios.create() with a bare stub that has no interceptors.
  if (!client?.interceptors?.response) return;

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      recordTelcoHttpStatus(response.status);
      return response;
    },
    (error: unknown) => {
      recordTelcoHttpStatus((error as { response?: { status?: number } })?.response?.status);
      return Promise.reject(error);
    },
  );
}

function statusFromError(error: unknown): number | undefined {
  const e = error as {
    response?: { status?: number };
    statusCode?: number;
    status?: number;
    httpStatus?: number;
  } | undefined;
  return e?.response?.status ?? e?.statusCode ?? e?.status ?? e?.httpStatus;
}

export interface TelcoSpanOptions {
  provider: string;
  operation: string;
  /** Used only to infer the country; never recorded. */
  phoneNumber?: string;
}

/**
 * Runs `fn` inside a telco CLIENT span. `telco.duration_ms` is always set;
 * `telco.status_code` is set from the HTTP interceptor when the provider uses
 * an instrumented client, otherwise from the result/error when it carries one.
 */
export async function withTelcoSpan<T>(
  options: TelcoSpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TELCO_TRACER_NAME);
  const country = resolveTelcoCountry(options.provider, options.phoneNumber);

  return tracer.startActiveSpan(
    `telco.${options.operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: sanitizeSpanAttributes({
        [TELCO_ATTR.PROVIDER]: options.provider,
        ...(country ? { [TELCO_ATTR.COUNTRY]: country } : {}),
      }),
    },
    async (span) => {
      const state: { statusCode?: number } = {};
      telcoSpans.set(span, state);
      const startedAt = Date.now();
      try {
        const result = await fn();
        if (state.statusCode === undefined) {
          const inferred = statusFromError((result as { error?: unknown } | undefined)?.error);
          if (inferred !== undefined) {
            span.setAttributes({ [TELCO_ATTR.STATUS_CODE]: inferred });
          }
        }
        if ((result as { success?: boolean } | undefined)?.success === false) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (state.statusCode === undefined) {
          const inferred = statusFromError(err);
          if (inferred !== undefined) {
            span.setAttributes({ [TELCO_ATTR.STATUS_CODE]: inferred });
          }
        }
        // recordException would attach the raw message, which can embed phone
        // numbers or tokens, so scrub it first.
        span.recordException(
          new Error(sanitizeSpanAttributes({ m: error.message }).m as string),
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.setAttributes({ [TELCO_ATTR.DURATION_MS]: Date.now() - startedAt });
        span.end();
      }
    },
  );
}
