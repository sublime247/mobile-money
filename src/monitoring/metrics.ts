import { Counter, Gauge } from "prom-client";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { register } from "../utils/metrics";

export { register } from "../utils/metrics";
export {
  startStellarCollector,
  stopStellarCollector,
  refreshStellarWalletMetrics,
  stellarWalletBaseReserveUtilizationPercent,
  stellarWalletReserveBytes,
  stellarWalletSequenceNumber,
  stellarWalletSubentriesTotal,
  stellarWalletXlmBalance,
} from "./stellarCollector";

/**
 * FX Exchange Rate Cache Metrics (#2505)
 * Counters for cache hits and misses on high-frequency FX rate lookups to monitor cache efficacy.
 */
export const fxCacheRequestsTotal = new Counter({
  name: "fx_cache_requests_total",
  help: "Total number of FX exchange rate cache requests",
  labelNames: ["result"] as const,
  registers: [register],
});

export const fxCacheHitRatio = new Gauge({
  name: "fx_cache_hit_ratio",
  help: "FX exchange rate cache hit ratio (hits / (hits + misses))",
  registers: [register],
});

type PushProvider = "mpesa" | "mtn";
type PushOutcome = "success" | "failed" | "timeout";

export const ussdPushRequestsTotal = new Counter({
  name: "ussd_push_requests_total",
  help: "USSD payment prompt dispatches and terminal outcomes",
  labelNames: ["provider", "country", "status"] as const,
  registers: [register],
});

const confirmationDeadlineMs = 5 * 60_000;
const pending = new Map<string, { country: string; timer: NodeJS.Timeout }>();
const completed = new Map<string, number>();

export function mtnPushCountry(phone?: unknown): string {
  if (typeof phone === "string" && /^\+?\d{8,15}$/.test(phone)) {
    const country = parsePhoneNumberFromString(
      phone.startsWith("+") ? phone : `+${phone}`,
    )?.country;
    if (country) return country;
  }
  const configured = process.env.MTN_COUNTRY_CODE?.toUpperCase();
  return configured && /^[A-Z]{2}$/.test(configured) ? configured : "unknown";
}

export function recordUssdPushDispatch(
  provider: PushProvider,
  country: string,
  reference: string,
): void {
  const key = `${provider}:${reference}`;
  if (pending.has(key)) return;

  ussdPushRequestsTotal.inc({ provider, country, status: "dispatched" });
  if ((completed.get(key) ?? 0) > Date.now()) return;

  const timer = setTimeout(() => {
    recordUssdPushOutcome(provider, country, reference, "timeout");
  }, confirmationDeadlineMs);
  timer.unref();
  pending.set(key, { country, timer });
}

export function recordUssdPushOutcome(
  provider: PushProvider,
  country: string,
  reference: string,
  status: PushOutcome,
  requireDispatch = false,
): void {
  const key = `${provider}:${reference}`;
  const tracked = pending.get(key);
  if ((requireDispatch && !tracked) || (completed.get(key) ?? 0) > Date.now()) {
    return;
  }
  if (tracked) {
    clearTimeout(tracked.timer);
    pending.delete(key);
  }

  // Bound callback deduplication state. Provider references stay out of labels.
  completed.delete(key);
  completed.set(key, Date.now() + confirmationDeadlineMs);
  if (completed.size > 50_000) {
    const oldest = completed.keys().next();
    if (!oldest.done) completed.delete(oldest.value);
  }
  ussdPushRequestsTotal.inc({
    provider,
    country: tracked?.country ?? country,
    status,
  });
}

export function mtnPushOutcome(
  status: unknown,
  reason: unknown,
): PushOutcome | undefined {
  const timedOut = (value: unknown) =>
    typeof value === "string" &&
    /TIME[_ ]?OUT|TIMED[_ ]?OUT|EXPIRED/i.test(value);
  if (status === "SUCCESSFUL" || status === "SUCCESS") return "success";
  if (timedOut(status)) return "timeout";
  if (status === "FAILED" || status === "REJECTED") {
    const reasonCode =
      typeof reason === "object" && reason !== null && "code" in reason
        ? reason.code
        : reason;
    return timedOut(reasonCode) ? "timeout" : "failed";
  }
  return undefined;
}
