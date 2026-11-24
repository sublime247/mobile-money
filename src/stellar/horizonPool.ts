import * as StellarSdk from "@stellar/stellar-sdk";
import logger from "../utils/logger";
import {
  horizonCircuitBreakerState,
  horizonFailoverAlertsTotal,
  horizonNodeFailuresTotal,
  horizonNodeHealth,
  horizonProbeLatencySeconds,
  horizonRequestFailoverTotal,
} from "../utils/metrics";
import {
  DEFAULT_MAX_LEDGER_LAG,
  DEFAULT_MAX_RESPONSE_MS,
  assessNodeHealth,
  defaultRootFetcher,
  findTipLedger,
  probeHorizonRoot,
  type HorizonRootFetcher,
  type RootProbeSample,
} from "./horizonHealthChecker";

/**
 * Horizon client rotation & automated failover.
 *
 * The Stellar integration historically depended on a single Horizon URL. If
 * that node went down or rate-limited us, every Stellar operation failed. This
 * module manages a *pool* of Horizon servers and rotates between them
 * round-robin, automatically retrying a failed request on an alternative node.
 *
 * Failover is transparent: `getPooledServer()` returns a Proxy that quacks like
 * a `StellarSdk.Horizon.Server`. Direct calls (`loadAccount`, `submitTransaction`,
 * …) and builder chains (`server.transactions().forAccount(id).call()`) are
 * recorded and replayed against the next healthy node when the active one fails,
 * so existing call sites get failover without any code changes.
 *
 * Active probes check each node's root endpoint for latency and ledger lag
 * (see `horizonHealthChecker.ts`). A node that is slow or more than
 * `maxLedgerLag` ledgers behind the pool tip is removed from the preferred
 * rotation until a later probe passes. Traffic only reaches such a node when
 * no preferred node is available.
 */

// Server methods that perform network I/O directly and should be retried.
const DIRECT_METHODS = new Set<string>([
  "loadAccount",
  "submitTransaction",
  "submitAsyncTransaction",
  "fetchBaseFee",
  "fetchTimebounds",
  "feeStats",
  "root",
]);

// Server methods that return a CallBuilder. The returned builder is wrapped so
// the whole chain can be replayed on an alternative node when `.call()` fails.
const BUILDER_METHODS = new Set<string>([
  "accounts",
  "transactions",
  "operations",
  "payments",
  "effects",
  "ledgers",
  "offers",
  "orderbook",
  "trades",
  "assets",
  "claimableBalances",
  "liquidityPools",
  "tradeAggregation",
  "strictReceivePaths",
  "strictSendPaths",
  "paths",
]);

export type CircuitState = "closed" | "open" | "half_open";

export class NodeCircuitBreaker {
  failures = 0;
  downUntil = 0;
  state: CircuitState = "closed";

  constructor(
    readonly threshold = 3,
    readonly cooldownMs = 30_000,
  ) {}

  isDown(now = Date.now()): boolean {
    if (this.state === "closed") return false;
    if (now >= this.downUntil) {
      this.state = "half_open";
      return false;
    }
    return true;
  }

  recordFailure(now = Date.now()): boolean {
    this.failures += 1;
    if (this.failures < this.threshold) return false;

    const wasOpen = this.state === "open" && this.downUntil > now;
    this.state = "open";
    this.downUntil = now + this.cooldownMs;
    return !wasOpen;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.downUntil = 0;
    this.state = "closed";
  }
}

export interface HorizonNode {
  url: string;
  server: StellarSdk.Horizon.Server;
  breaker: NodeCircuitBreaker;
  /** False while the latest probe judged the node slow or lagging. */
  probeHealthy: boolean;
}

export interface HealthProbeResult {
  node: string;
  ok: boolean;
  latencyMs: number;
  status?: number;
  ledger?: number;
  ledgerLag?: number;
  error?: string;
}

/** Transport used by health probes. Same shape as {@link HorizonRootFetcher}. */
export type HorizonHealthProbe = HorizonRootFetcher;

export interface HorizonPoolConfig {
  /** Consecutive failover-eligible failures before a node is taken out of rotation. */
  maxConsecutiveFailures: number;
  /** How long (ms) a node stays out of rotation after being marked down. */
  cooldownMs: number;
  /** How often active health probes run. */
  probeIntervalMs: number;
  /** A probe slower than this (ms) marks the node unhealthy. */
  latencyThresholdMs: number;
  /** A node more than this many ledgers behind the tip is marked unhealthy. */
  maxLedgerLag: number;
  /** Timeout applied to an individual probe request. */
  probeTimeoutMs: number;
  /** Overridable probe transport (used by tests). */
  probe?: HorizonHealthProbe;
}

const DEFAULT_CONFIG: HorizonPoolConfig = {
  maxConsecutiveFailures: parseInt(
    process.env.HORIZON_MAX_CONSECUTIVE_FAILURES || "3",
    10,
  ),
  cooldownMs: parseInt(process.env.HORIZON_COOLDOWN_MS || "30000", 10),
  probeIntervalMs: parseInt(
    process.env.HORIZON_PROBE_INTERVAL_MS || "15000",
    10,
  ),
  latencyThresholdMs: parseInt(
    process.env.HORIZON_LATENCY_THRESHOLD_MS || String(DEFAULT_MAX_RESPONSE_MS),
    10,
  ),
  maxLedgerLag: parseInt(
    process.env.HORIZON_MAX_LEDGER_LAG || String(DEFAULT_MAX_LEDGER_LAG),
    10,
  ),
  probeTimeoutMs: parseInt(
    process.env.HORIZON_PROBE_TIMEOUT_MS || String(DEFAULT_MAX_RESPONSE_MS),
    10,
  ),
};

/**
 * Decide whether an error means "this node is unhealthy, try another" rather
 * than "this request is bad, retrying won't help".
 *
 * Failover-eligible: network/connection errors, timeouts, HTTP 429 (rate
 * limited) and 5xx (server errors). NOT eligible: 4xx like 400/404 (e.g.
 * tx_failed, account not found) which are deterministic across nodes.
 */
export function isFailoverEligible(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as {
    response?: { status?: number };
    code?: string;
    name?: string;
    message?: string;
  };

  const status = err.response?.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500) return true;
    // Any other HTTP response (4xx) is a deterministic client error.
    return false;
  }

  // No HTTP response → network-level failure (connection refused, reset,
  // DNS, timeout, etc.). These are exactly the cases another node may serve.
  const code = err.code ?? "";
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "ECONNABORTED",
    ].includes(code)
  ) {
    return true;
  }

  const name = err.name ?? "";
  const message = err.message ?? "";
  // stellar-sdk throws NetworkError when no response was received.
  if (name === "NetworkError") return true;
  if (/timeout|network|socket hang up/i.test(message)) return true;

  return false;
}

export class HorizonPool {
  private readonly nodes: HorizonNode[];
  private readonly config: HorizonPoolConfig;
  private cursor = 0;
  /** Cached transparent-failover proxy. */
  private proxy: StellarSdk.Horizon.Server | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeInFlight: Promise<HealthProbeResult[]> | null = null;

  constructor(urls: string[], config: Partial<HorizonPoolConfig> = {}) {
    if (urls.length === 0) {
      throw new Error("HorizonPool requires at least one Horizon URL");
    }
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.nodes = urls.map((url) => ({
      url,
      server: new StellarSdk.Horizon.Server(url, {
        allowHttp: url.startsWith("http://") || process.env.NODE_ENV === "test",
      }),
      breaker: new NodeCircuitBreaker(
        this.config.maxConsecutiveFailures,
        this.config.cooldownMs,
      ),
      probeHealthy: true,
    }));
    // Initialise health gauge so all nodes are visible in Prometheus.
    for (const node of this.nodes) {
      horizonNodeHealth.set({ node: node.url }, 1);
      horizonCircuitBreakerState.set({ node: node.url }, 0);
    }
  }

  /** URLs in the pool, in configured order. */
  get urls(): string[] {
    return this.nodes.map((n) => n.url);
  }

  /**
   * Build the ordered list of nodes to try for one request: preferred nodes
   * first (round-robin starting at the cursor), then the rest as a last resort
   * so the pool degrades gracefully instead of failing hard. A node is
   * preferred when its breaker is closed and its latest probe passed.
   */
  private candidateOrder(): HorizonNode[] {
    const now = Date.now();
    const rotated: HorizonNode[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      rotated.push(this.nodes[(this.cursor + i) % this.nodes.length]);
    }
    const isPreferred = (n: HorizonNode) =>
      n.probeHealthy && !n.breaker.isDown(now);
    const preferred = rotated.filter(isPreferred);
    const rest = rotated.filter((n) => !isPreferred(n));
    return preferred.length > 0 ? [...preferred, ...rest] : rotated;
  }

  private markSuccess(node: HorizonNode): void {
    if (node.breaker.failures > 0 || node.breaker.downUntil > 0) {
      logger.info(
        { horizon_node: node.url },
        "Horizon node recovered, back in rotation",
      );
    }
    node.breaker.recordSuccess();
    horizonNodeHealth.set({ node: node.url }, 1);
    horizonCircuitBreakerState.set({ node: node.url }, 0);
  }

  private markFailure(
    node: HorizonNode,
    operation: string,
    error: unknown,
    errorTypeOverride?: string,
  ): boolean {
    const errorType = errorTypeOverride ?? classifyError(error);
    horizonNodeFailuresTotal.inc({ node: node.url, error_type: errorType });

    const tripped = node.breaker.recordFailure();

    logger.warn(
      {
        horizon_node: node.url,
        operation,
        error_type: errorType,
        consecutive_failures: node.breaker.failures,
        disabled: tripped,
        cooldown_ms: tripped ? this.config.cooldownMs : undefined,
        err: error instanceof Error ? error.message : String(error),
      },
      tripped
        ? "Horizon node failed and was removed from rotation"
        : "Horizon node request failed",
    );

    if (tripped) {
      horizonNodeHealth.set({ node: node.url }, 0);
      horizonCircuitBreakerState.set({ node: node.url }, 1);
      this.announceFailover(node, operation, errorType);
    }
    return tripped;
  }

  private announceFailover(
    failedNode: HorizonNode,
    operation: string,
    reason: string,
  ): void {
    const next = this.candidateOrder().find((node) => node !== failedNode);
    horizonFailoverAlertsTotal.inc(
      { from_node: failedNode.url, to_node: next?.url ?? "none" },
      1,
    );
    logger.warn(
      {
        event: "horizon_failover",
        operation,
        from_node: failedNode.url,
        to_node: next?.url ?? null,
        reason,
        consecutive_failures: failedNode.breaker.failures,
      },
      "Horizon failover: switching traffic to a healthy node",
    );
  }

  /**
   * Run `fn` against pool nodes, retrying on an alternative node when the
   * active one fails with a failover-eligible error. Resolves with the first
   * success; rejects with the last error if every node is exhausted (or
   * immediately on a non-failover error).
   */
  async execute<T>(
    fn: (server: StellarSdk.Horizon.Server) => Promise<T>,
    operation = "request",
  ): Promise<T> {
    const candidates = this.candidateOrder();
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      try {
        const result = await fn(node.server);
        this.markSuccess(node);
        // Advance the round-robin cursor past the node that served the request.
        this.cursor = (this.nodes.indexOf(node) + 1) % this.nodes.length;
        return result;
      } catch (error) {
        lastError = error;
        if (!isFailoverEligible(error)) {
          // Deterministic error (bad request, not found, …) — another node
          // would return the same thing. Don't penalise the node, just throw.
          throw error;
        }
        this.markFailure(node, operation, error);
        const next = candidates[i + 1];
        if (next) {
          horizonRequestFailoverTotal.inc({
            from_node: node.url,
            to_node: next.url,
            operation,
          });
          logger.warn(
            {
              operation,
              from_node: node.url,
              to_node: next.url,
            },
            "Retrying Horizon request on alternative node",
          );
        }
      }
    }

    logger.error(
      { operation, nodes: this.urls.length },
      "All Horizon nodes failed for request",
    );
    throw lastError;
  }

  /** The currently-preferred underlying server (for streaming / passthrough). */
  getActiveServer(): StellarSdk.Horizon.Server {
    return this.candidateOrder()[0].server;
  }

  private sampleNode(node: HorizonNode): Promise<RootProbeSample> {
    return probeHorizonRoot(
      node.url,
      this.config.probeTimeoutMs,
      this.config.probe ?? defaultRootFetcher,
    );
  }

  /**
   * Probe one node. Without `tipLedger` the node is only checked for latency
   * and its own ledger is treated as the tip, so no lag is charged.
   */
  async probeNode(
    node: HorizonNode,
    tipLedger?: number,
  ): Promise<HealthProbeResult> {
    const sample = await this.sampleNode(node);
    return this.applyProbe(node, sample, tipLedger);
  }

  /** Judge a probe sample and update the node's routing state. */
  private applyProbe(
    node: HorizonNode,
    sample: RootProbeSample,
    tipLedger: number | undefined,
  ): HealthProbeResult {
    const assessment = assessNodeHealth(sample, tipLedger, {
      maxResponseMs: this.config.latencyThresholdMs,
      maxLedgerLag: this.config.maxLedgerLag,
    });

    horizonProbeLatencySeconds.observe(
      { node: node.url, status: assessment.healthy ? "success" : "failure" },
      sample.latencyMs / 1000,
    );

    if (assessment.healthy) {
      node.probeHealthy = true;
      this.markSuccess(node);
    } else {
      node.probeHealthy = false;
      horizonNodeHealth.set({ node: node.url }, 0);
      const reason = assessment.reason ?? "network";
      if (reason === "latency" || reason === "ledger_lag") {
        // Reachable but degraded: move traffic away without spending the
        // circuit-breaker budget that tracks hard failures.
        horizonNodeFailuresTotal.inc({ node: node.url, error_type: reason });
        logger.warn(
          {
            horizon_node: node.url,
            reason,
            latency_ms: sample.latencyMs,
            ledger_lag: assessment.ledgerLag,
            tip_ledger: tipLedger,
          },
          "Horizon node degraded, removed from preferred rotation",
        );
      } else {
        this.markFailure(
          node,
          "health_probe",
          new Error(sample.error ?? reason),
          reason,
        );
      }
    }

    return {
      node: node.url,
      ok: assessment.healthy,
      latencyMs: sample.latencyMs,
      status: sample.status,
      ledger: sample.ledger,
      ledgerLag: assessment.ledgerLag,
      error: assessment.healthy
        ? undefined
        : (sample.error ?? assessment.reason),
    };
  }

  async runHealthProbeCycle(): Promise<HealthProbeResult[]> {
    if (this.probeInFlight) return this.probeInFlight;
    this.probeInFlight = Promise.all(
      this.nodes.map((node) => this.sampleNode(node)),
    )
      .then((samples) => {
        // The tip is the highest ledger any node reported this cycle.
        const tip = findTipLedger(samples);
        const results = this.nodes.map((node, i) =>
          this.applyProbe(node, samples[i], tip),
        );
        logger.debug(
          {
            horizon_nodes: results.map((result) => ({
              node: result.node,
              ok: result.ok,
              latency_ms: result.latencyMs,
              ledger_lag: result.ledgerLag,
            })),
          },
          "Horizon health probe cycle complete",
        );
        return results;
      })
      .finally(() => {
        this.probeInFlight = null;
      });
    return this.probeInFlight;
  }

  startHealthProbes(): void {
    if (this.probeTimer) return;
    void this.runHealthProbeCycle();
    this.probeTimer = setInterval(() => {
      void this.runHealthProbeCycle();
    }, this.config.probeIntervalMs);
    this.probeTimer.unref?.();
  }

  stopHealthProbes(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /**
   * A `StellarSdk.Horizon.Server`-compatible Proxy that transparently routes
   * network operations through {@link execute}. Returned object is cached.
   */
  getProxiedServer(): StellarSdk.Horizon.Server {
    if (!this.proxy) {
      this.proxy = this.buildServerProxy();
    }
    return this.proxy;
  }

  private buildServerProxy(): StellarSdk.Horizon.Server {
    const pool = this;
    const target = this.getActiveServer();

    return new Proxy(target, {
      get(_t, prop: string | symbol) {
        if (typeof prop !== "string") {
          return Reflect.get(pool.getActiveServer(), prop);
        }

        if (DIRECT_METHODS.has(prop)) {
          return (...args: unknown[]) =>
            pool.execute((server) => (server as any)[prop](...args), prop);
        }

        if (BUILDER_METHODS.has(prop)) {
          return (...args: unknown[]) =>
            pool.buildBuilderProxy([{ method: prop, args }]);
        }

        // Anything else (properties, helpers like serverURL) → delegate to the
        // active server. These don't perform retriable network I/O.
        const active = pool.getActiveServer() as any;
        const value = active[prop];
        return typeof value === "function" ? value.bind(active) : value;
      },
    });
  }

  /**
   * Wrap a CallBuilder chain so configuration calls are recorded and `.call()`
   * is replayed against an alternative node on failure. `.stream()` is built on
   * the active server (long-lived streams aren't retried).
   */
  private buildBuilderProxy(
    chain: Array<{ method: string; args: unknown[] }>,
  ): any {
    const pool = this;

    const replay = (server: StellarSdk.Horizon.Server) => {
      let builder: any = (server as any)[chain[0].method](...chain[0].args);
      for (let i = 1; i < chain.length; i++) {
        builder = builder[chain[i].method](...chain[i].args);
      }
      return builder;
    };

    const operation = `${chain[0].method}.call`;

    return new Proxy(function () {}, {
      get(_t, prop: string | symbol) {
        if (prop === "call") {
          return (...args: unknown[]) =>
            pool.execute((server) => replay(server).call(...args), operation);
        }
        if (prop === "stream") {
          return (...args: unknown[]) =>
            replay(pool.getActiveServer()).stream(...args);
        }
        if (typeof prop !== "string") {
          return undefined;
        }
        // Chainable config method (limit, order, cursor, forAccount, …): record
        // it and return a new recording builder.
        return (...args: unknown[]) =>
          pool.buildBuilderProxy([...chain, { method: prop, args }]);
      },
    });
  }
}

function classifyError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const err = error as {
    response?: { status?: number };
    code?: string;
    name?: string;
  };
  const status = err.response?.status;
  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500) return "server_error";
  if (err.code) return err.code.toLowerCase();
  if (err.name === "NetworkError") return "network_error";
  return "network_error";
}
