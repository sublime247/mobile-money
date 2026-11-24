/**
 * Horizon node health checks.
 *
 * Each configured Horizon node is probed through its root endpoint (`GET /`),
 * which reports the node's latest ledger. A node is healthy when:
 *
 *   - the probe returns a 2xx response with a parseable ledger,
 *   - the response arrived within `maxResponseMs`, and
 *   - the node is at most `maxLedgerLag` ledgers behind the pool's tip (the
 *     highest ledger reported by any node in the same probe cycle).
 *
 * The functions here are pure apart from the default transport, so the pool
 * can apply the same rules whether a probe came from the network or a test.
 */

export const DEFAULT_MAX_RESPONSE_MS = 3000;
export const DEFAULT_MAX_LEDGER_LAG = 3;

export interface HorizonRootResponse {
  status: number;
  body?: unknown;
}

/** Transport used to fetch a Horizon root document. Overridable in tests. */
export type HorizonRootFetcher = (
  url: string,
  timeoutMs: number,
) => Promise<HorizonRootResponse>;

export type ProbeFailureReason =
  | "timeout"
  | "network"
  | "http_error"
  | "invalid_root"
  | "latency"
  | "ledger_lag";

/** Raw outcome of probing one node, before any health judgement. */
export interface RootProbeSample {
  node: string;
  /** True when the node answered 2xx with a usable ledger number. */
  ok: boolean;
  latencyMs: number;
  status?: number;
  ledger?: number;
  reason?: ProbeFailureReason;
  error?: string;
}

export interface NodeHealthAssessment {
  node: string;
  healthy: boolean;
  latencyMs: number;
  ledger?: number;
  /** Ledgers behind the tip. Undefined when the node reported no ledger. */
  ledgerLag?: number;
  reason?: ProbeFailureReason;
}

export interface HealthThresholds {
  maxResponseMs: number;
  maxLedgerLag: number;
}

export class ProbeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Health probe timed out after ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Read the latest ledger from a Horizon root document. Prefers the history
 * ledger (what the API serves) and falls back to the core ledger.
 */
export function extractRootLedger(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  for (const key of ["history_latest_ledger", "core_latest_ledger"]) {
    const value = root[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  return undefined;
}

/** Default transport: `GET <node>/` with JSON accept header. */
export const defaultRootFetcher: HorizonRootFetcher = async (
  url,
  timeoutMs,
) => {
  const response = await fetch(`${url.replace(/\/+$/, "")}/`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

/**
 * Probe one node's root endpoint. The timeout is enforced here as well as in
 * the transport, so a fetcher that ignores its abort signal still cannot hang
 * a probe cycle.
 */
export async function probeHorizonRoot(
  node: string,
  timeoutMs: number,
  fetcher: HorizonRootFetcher = defaultRootFetcher,
): Promise<RootProbeSample> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });

  try {
    const response = await Promise.race([fetcher(node, timeoutMs), timeout]);
    const latencyMs = Date.now() - startedAt;

    if (response.status < 200 || response.status >= 300) {
      return {
        node,
        ok: false,
        latencyMs,
        status: response.status,
        reason: "http_error",
        error: `Root endpoint returned ${response.status}`,
      };
    }

    const ledger = extractRootLedger(response.body);
    if (ledger === undefined) {
      return {
        node,
        ok: false,
        latencyMs,
        status: response.status,
        reason: "invalid_root",
        error: "Root document has no ledger number",
      };
    }
    return { node, ok: true, latencyMs, status: response.status, ledger };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof ProbeTimeoutError) {
      return {
        node,
        ok: false,
        latencyMs,
        reason: "timeout",
        error: error.message,
      };
    }
    return {
      node,
      ok: false,
      latencyMs,
      reason: "network",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Highest ledger reported in a probe cycle, or undefined if none reported one. */
export function findTipLedger(samples: RootProbeSample[]): number | undefined {
  let tip: number | undefined;
  for (const sample of samples) {
    if (
      sample.ledger !== undefined &&
      (tip === undefined || sample.ledger > tip)
    ) {
      tip = sample.ledger;
    }
  }
  return tip;
}

/**
 * Judge one sample against the thresholds. `tipLedger` is the pool-wide tip for
 * this cycle; when omitted the node is compared with itself (no lag).
 */
export function assessNodeHealth(
  sample: RootProbeSample,
  tipLedger: number | undefined,
  thresholds: HealthThresholds,
): NodeHealthAssessment {
  const base = {
    node: sample.node,
    latencyMs: sample.latencyMs,
    ledger: sample.ledger,
  };

  if (!sample.ok || sample.ledger === undefined) {
    return { ...base, healthy: false, reason: sample.reason ?? "network" };
  }

  const ledgerLag = Math.max(0, (tipLedger ?? sample.ledger) - sample.ledger);
  if (sample.latencyMs > thresholds.maxResponseMs) {
    return { ...base, healthy: false, ledgerLag, reason: "latency" };
  }
  if (ledgerLag > thresholds.maxLedgerLag) {
    return { ...base, healthy: false, ledgerLag, reason: "ledger_lag" };
  }
  return { ...base, healthy: true, ledgerLag };
}

/** Probe every node in parallel, then judge each against the shared tip. */
export async function checkHorizonNodes(
  urls: string[],
  timeoutMs: number,
  thresholds: HealthThresholds,
  fetcher: HorizonRootFetcher = defaultRootFetcher,
): Promise<NodeHealthAssessment[]> {
  const samples = await Promise.all(
    urls.map((url) => probeHorizonRoot(url, timeoutMs, fetcher)),
  );
  const tip = findTipLedger(samples);
  return samples.map((sample) => assessNodeHealth(sample, tip, thresholds));
}
