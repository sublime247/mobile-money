import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import https from "https";
import winston from "winston";
import Transport from "winston-transport";
import DailyRotateFile from "winston-daily-rotate-file";
import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import { REDACT_KEYS } from "./redact";
import { AsyncLocalStorage } from "async_hooks";
import {
  momoProviderRequestDurationSeconds,
  momoProviderErrorsTotal,
} from "./metrics";

export const requestContext = new AsyncLocalStorage<{
  trace_id: string;
  /** X-Correlation-ID propagated across services for a single logical request (#1996). */
  correlation_id?: string;
}>();

/**
 * Centralized Winston Structured Logger
 *
 * Schema: every log line includes
 *   time        – ISO-8601
 *   level       – uppercase string (INFO, ERROR, …)
 *   instance_id – hostname + PID, stable per process
 *   trace_id    – populated by callers via child() or request context
 *   service     – service name from SERVICE_NAME env var
 *
 * Transport:
 *   - Production / CI  → raw JSON to stdout (pipe to log aggregator).
 *                       Activated by NODE_ENV=production, LOG_FORMAT=json,
 *                       or by leaving LOG_FORMAT unset (default is "json").
 *   - Development      → human-readable coloured output on stdout
 *                        (enabled when LOG_PRETTY=true or LOG_FORMAT=pretty).
 *                        The rotating file stream and Loki transport always
 *                        receive JSON regardless of stdout formatting.
 *   - Always writes to stdout (fallback / CI-safe)
 *   - Optionally ships to Loki when LOKI_HOST is set. The Loki transport
 *     batches entries and flushes asynchronously so log ingestion never
 *     blocks the event loop.
 *   - If LOKI_HOST is unreachable the transport silently drops and stdout
 *     continues — CI never fails due to a missing sink.
 *
 * Redaction: sensitive fields are replaced with [REDACTED] before any
 * transport sees them.
 */

const SERVICE_NAME = process.env.SERVICE_NAME ?? "mobile-money-api";
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), "logs");
const LOG_FILE_SIZE = process.env.LOG_FILE_SIZE ?? "10M";
const configuredRetention = Number(process.env.LOG_FILE_RETENTION ?? 14);
const LOG_FILE_RETENTION = Number.isFinite(configuredRetention)
  ? configuredRetention
  : 14;
const SCRUB_CENSOR = "[REDACTED]";

// ---------------------------------------------------------------------------
// Output format
//
// LOG_FORMAT strictly defaults to "json" so production log aggregators
// (Loki, ELK, CloudWatch, Datadog) can ingest every line without
// transformation. NODE_ENV=production forces JSON even if LOG_FORMAT is
// misconfigured. In non-production environments developers can opt into
// pretty coloured output via LOG_FORMAT=pretty or LOG_PRETTY=true for
// readable local development. Pretty output is only applied to stdout —
// the rotating file stream and Loki transport always receive JSON.
// ---------------------------------------------------------------------------

const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_PRODUCTION = NODE_ENV === "production";
const LOG_FORMAT = (process.env.LOG_FORMAT ?? "json").toLowerCase();
const LOG_PRETTY = process.env.LOG_PRETTY === "true";
// Production always emits JSON; non-production can opt into pretty stdout.
const USE_PRETTY_STDOUT =
  !IS_PRODUCTION && (LOG_FORMAT === "pretty" || LOG_PRETTY);

// ---------------------------------------------------------------------------
// Global regex scrub filters — applied inside every format so secrets
// never reach stdout, rotating files, or Loki regardless of log verbosity.
// ---------------------------------------------------------------------------

/** Extra PII master-key field names not covered by generic REDACT_KEYS. */
const PII_MASTER_KEY_FIELDS = [
  "pii_master_key",
  "piiMasterKey",
  "PII_MASTER_KEY",
  "db_encryption_key",
  "dbEncryptionKey",
  "DB_ENCRYPTION_KEY",
];

/** User PII parameter field names to redact in logs */
export const PII_USER_FIELDS = [
  "email",
  "e_mail",
  "user_email",
  "userEmail",
  "phone",
  "phoneNumber",
  "phone_number",
  "mobile",
  "msisdn",
  "telephone",
  "first_name",
  "firstName",
  "last_name",
  "lastName",
  "display_name",
  "displayName",
  "full_name",
  "fullName",
  "user_name",
  "userName",
];

type ScrubFilter = { pattern: RegExp; replacement: string };

const PHONE_FIELDS =
  /^(?:phone(?:[_ -]?number)?|mobile(?:[_ -]?number)?|msisdn|telephone)$/i;
const ID_FIELDS =
  /^(?:(?:customer[_ -]?)?(?:national[_ -]?id(?:[_ -]?number)?|(?:identity|id)[_ -]?number)|bank[_ -]?account(?:[_ -]?(?:number|no))?|account[_ -]?(?:number|no)|iban)$/i;

const privateFields = Array.from(
  new Set(
    [
      ...REDACT_KEYS,
      ...PII_MASTER_KEY_FIELDS,
      ...PII_USER_FIELDS.filter((key) => !PHONE_FIELDS.test(key)),
    ].map((key) => key.toLowerCase().replace(/[_-]/g, "[_-]?")),
  ),
).join("|");

const privateJsonField = new RegExp(
  "([\"'])(" +
    privateFields +
    ")\\1\\s*:\\s*(?:\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*')",
  "gi",
);

const PII_SCRUB_REGEX_FILTERS: ScrubFilter[] = [
  // Bearer tokens embedded in message strings
  {
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: `Bearer ${SCRUB_CENSOR}`,
  },
  // Stellar secret keys (S…)
  {
    pattern: /\bS[A-Z2-7]{55}\b/g,
    replacement: SCRUB_CENSOR,
  },
  // Standalone email addresses
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: SCRUB_CENSOR,
  },
  // JWT tokens anywhere in text (three base64url segments separated by dots)
  {
    pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: SCRUB_CENSOR,
  },
  // Hex-encoded private keys (64+ consecutive hex chars — likely 256-bit keys)
  {
    pattern: /\b[a-fA-F0-9]{64,}\b/g,
    replacement: SCRUB_CENSOR,
  },
  // Base64-encoded secrets (40+ base64 chars — likely encrypted payloads)
  {
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    replacement: SCRUB_CENSOR,
  },
  // Stellar public addresses (G… 56 chars) — redact from logs to prevent
  // address correlation via log aggregation
  {
    pattern: /\bG[A-Z2-7]{55}\b/g,
    replacement: SCRUB_CENSOR,
  },
  // Stellar transaction hash or hex identifiers (64 hex chars)
  {
    pattern: /\b[a-f0-9]{64}\b/g,
    replacement: SCRUB_CENSOR,
  },
  // Stellar base64 transaction envelope XDR (long base64 with +/=)
  {
    pattern: /\bAAAA[A-Za-z0-9+/=]{100,}\b/g,
    replacement: SCRUB_CENSOR,
  },
];

const PII_KEY_VALUE_PATTERN =
  /\b(master[_-]?key|pii[_-]?master[_-]?key|db[_-]?encryption[_-]?key|email|user[_-]?email|first[_-]?name|last[_-]?name|display[_-]?name|full[_-]?name|user[_-]?name)\s*[=:]\s*['"]?[^\s'",}]+['"]?/gi;

const FINANCIAL_FIELD =
  /((?:\\?["'])?\b((?:customer[_ -]?)?(?:national[_ -]?id(?:[_ -]?number)?|(?:identity|id)[_ -]?number)|bank[_ -]?account(?:[_ -]?(?:number|no))?|account[_ -]?(?:number|no)|iban|phone(?:[_ -]?number)?|mobile(?:[_ -]?number)?|msisdn|telephone)(?:\\?["'])?\s*[=:]\s*)(?:(\\?["'])(.*?)\3|([+\w(][\w().-]*(?:[ .()-]+\d+)*))/gi;
const callingCodes = new Set<string>(
  getCountries().map((country) => getCountryCallingCode(country)),
);
const INTERNATIONAL_PHONE =
  /(?<![\w+])\+[1-9](?:[ .()-]?\d){7,14}(?![ .()-]?\d)/g;

function maskLoggedPhone(value: string): string {
  if (/^\+[1-9]\d{0,2}\*{5}\d{3}$/.test(value)) return value;
  const digits = value.replace(/[ .()-]/g, "");
  if (!/^\+?[1-9]\d{7,14}$/.test(digits)) return SCRUB_CENSOR;
  const international = digits.startsWith("+") ? digits.slice(1) : digits;
  const code = [1, 2, 3]
    .map((length) => international.slice(0, length))
    .find((prefix) => callingCodes.has(prefix));
  return code ? "+" + code + "*****" + international.slice(-3) : SCRUB_CENSOR;
}

export function scrubLogOutput(chunk: string): string {
  let result = chunk
    .replace(
      FINANCIAL_FIELD,
      (
        _match,
        prefix: string,
        key: string,
        quote: string | undefined,
        quoted: string | undefined,
        unquoted: string | undefined,
      ) => {
        const value = PHONE_FIELDS.test(key)
          ? maskLoggedPhone(quoted ?? unquoted ?? "")
          : SCRUB_CENSOR;
        const delimiter = quote ?? (/^["']/.test(prefix) ? prefix[0] : "");
        return prefix + delimiter + value + delimiter;
      },
    )
    .replace(INTERNATIONAL_PHONE, maskLoggedPhone)
    .replace(
      PII_KEY_VALUE_PATTERN,
      (_match, key: string) => key + "=" + SCRUB_CENSOR,
    )
    .replace(
      privateJsonField,
      (_match, quote: string, key: string) =>
        quote + key + quote + ":" + quote + SCRUB_CENSOR + quote,
    );

  for (const { pattern, replacement } of PII_SCRUB_REGEX_FILTERS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Express middleware for sanitizing PII in request payloads and parameters */
export function logSanitizerMiddleware(req: any, res: any, next: any): void {
  if (req.body && typeof req.body === "object") {
    try {
      req.body = JSON.parse(scrubLogOutput(JSON.stringify(req.body)));
    } catch {}
  }
  if (req.query && typeof req.query === "object") {
    try {
      req.query = JSON.parse(scrubLogOutput(JSON.stringify(req.query)));
    } catch {}
  }
  if (req.params && typeof req.params === "object") {
    try {
      req.params = JSON.parse(scrubLogOutput(JSON.stringify(req.params)));
    } catch {}
  }
  if (typeof next === "function") next();
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * JSON.stringify with Error → { name, message, stack } conversion and
 * circular-reference protection so a misbehaving meta object can never
 * crash the logger (and therefore the request).
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, item: unknown) => {
    if (ID_FIELDS.test(key)) return SCRUB_CENSOR;
    if (PHONE_FIELDS.test(key)) {
      return typeof item === "string" || typeof item === "number"
        ? maskLoggedPhone(String(item))
        : SCRUB_CENSOR;
    }
    if (item instanceof Error) {
      return { name: item.name, message: item.message, stack: item.stack };
    }
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) {
        return "[Circular]";
      }
      seen.add(item);
    }
    return item;
  });
}

/**
 * Normalizes the relaxed `(msg | fields, ...args)` call signature into a
 * winston-friendly `(message, meta)` pair:
 *
 *   logger.info({ a: 1 }, "hello")  → message "hello", meta { a: 1 }
 *   logger.info("hello", { a: 1 })  → message "hello", meta { a: 1 }
 *   logger.info("hello")            → message "hello", meta {}
 *   logger.info({ a: 1 })           → message "",     meta { a: 1 }
 *   logger.error("boom", err)       → message "boom", meta { err }
 */
export function normalizeArgs(args: [string | object, ...unknown[]]): {
  message: string;
  meta: Record<string, unknown>;
} {
  const [first, ...rest] = args;

  if (typeof first === "string") {
    return {
      message: first,
      meta: toMetaObject(rest[0]),
    };
  }

  if (first instanceof Error) {
    return {
      message: first.message,
      meta: { err: first, ...toMetaObject(rest[0]) },
    };
  }

  if (typeof first === "object") {
    if (typeof rest[0] === "string") {
      return { message: rest[0], meta: first as Record<string, unknown> };
    }
    if (rest.length === 0) {
      return { message: "", meta: first as Record<string, unknown> };
    }
    const tail = rest[0];
    return {
      message: tail instanceof Error ? tail.message : String(tail ?? ""),
      meta: first as Record<string, unknown>,
    };
  }

  return { message: String(first ?? ""), meta: toMetaObject(rest[0]) };
}

function toMetaObject(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return { err: value };
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Winston configuration
// ---------------------------------------------------------------------------

/**
 * Custom levels ordered by severity (higher = more severe), matching the
 * previous pino layout:
 *
 *   error(50) > audit(45) > warn(40) > security(35) > info(30) > debug(20) > trace(10)
 *
 * Winston uses ascending numeric priority (0 = most severe), so the values
 * are inverted: error: 0 … trace: 6.
 */
export const LOG_LEVELS: Record<string, number> = {
  error: 0,
  warn: 1,
  audit: 2,
  security: 3,
  info: 4,
  debug: 5,
  trace: 6,
};

const KNOWN_LOG_LEVELS = Object.keys(LOG_LEVELS);
const ACTIVE_LOG_LEVEL = KNOWN_LOG_LEVELS.includes(LOG_LEVEL)
  ? LOG_LEVEL
  : "info";

winston.addColors({
  error: "red",
  warn: "yellow",
  audit: "magenta",
  security: "cyan",
  info: "green",
  debug: "gray",
  trace: "gray",
});

function enrichInfo(): winston.Logform.Format {
  return winston.format((info) => {
    const store = requestContext.getStore();
    if (store?.trace_id) {
      info.trace_id = store.trace_id;
    }
    if (store?.correlation_id) {
      info.correlation_id = store.correlation_id;
    }
    info.service = SERVICE_NAME;
    info.instance_id = INSTANCE_ID;
    return info;
  })();
}

/** JSON output: { time, level, service, instance_id, trace_id?, ...meta, msg? } */
export const jsonFormat = winston.format.combine(
  enrichInfo(),
  winston.format.timestamp(),
  winston.format.printf((info) => {
    const { level, message, timestamp, ...meta } = info as unknown as Record<
      string,
      unknown
    >;
    const payload: Record<string, unknown> = {
      time: (timestamp as string) ?? new Date().toISOString(),
      level: String(level ?? "info").toUpperCase(),
      service: SERVICE_NAME,
      instance_id: INSTANCE_ID,
    };

    if (typeof message === "string" && message.length > 0) {
      payload.msg = message;
    }

    // `level` and `message` are already handled above; everything else is
    // user-supplied structured metadata.
    for (const [key, value] of Object.entries(meta)) {
      if (key === "level" || key === "message" || key === "timestamp") {
        continue;
      }
      payload[key] = value;
    }

    return scrubLogOutput(safeStringify(payload));
  }),
);

/** Human-readable coloured output for local development (stdout only). */
export const prettyFormat = winston.format.combine(
  enrichInfo(),
  winston.format.timestamp(),
  winston.format.colorize(),
  winston.format.printf((info) => {
    const { level, message, timestamp, ...meta } = info as unknown as Record<
      string,
      unknown
    >;
    const extras = Object.entries(meta).filter(
      ([key]) => !["service", "instance_id", "trace_id"].includes(key),
    );
    const extrasStr = extras.length
      ? ` ${scrubLogOutput(safeStringify(Object.fromEntries(extras)))}`
      : "";
    const msg =
      typeof message === "string" && message.length > 0
        ? scrubLogOutput(message)
        : scrubLogOutput(safeStringify(meta));
    return `${String(timestamp ?? new Date().toISOString())} ${String(
      level,
    ).toUpperCase()}: ${msg}${extrasStr}`;
  }),
);

// ---------------------------------------------------------------------------
// Loki transport (batched, non-blocking, failure-tolerant)
// ---------------------------------------------------------------------------

interface LokiBatchEntry {
  timestamp: string; // nanosecond precision, Loki's expected format
  line: string;
}

function postToLoki(host: URL, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lib = host.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: host.hostname,
        port: host.port || undefined,
        path:
          host.pathname === "/" || host.pathname === ""
            ? "/loki/api/v1/push"
            : host.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Loki push timed out")));
    req.write(payload);
    req.end();
  });
}

class LokiTransport extends Transport {
  private readonly host: URL;
  private readonly labels: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private buffer: LokiBatchEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    host: string;
    labels?: Record<string, string>;
    batchSize?: number;
    flushIntervalMs?: number;
  }) {
    super();
    this.host = new URL(opts.host);
    this.labels = opts.labels ?? {};
    this.batchSize = opts.batchSize ?? 10;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  log(info: unknown, callback: () => void): void {
    setImmediate(() => {
      // winston stores the fully formatted line under Symbol.for("message")
      const line = (info as Record<symbol, unknown>)[Symbol.for("message")];
      if (typeof line === "string" && line.length > 0) {
        this.buffer.push({ timestamp: String(Date.now() * 1_000_000), line });
      }
      if (this.buffer.length >= this.batchSize) {
        void this.flush();
      }
      callback();
    });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const entries = this.buffer;
    this.buffer = [];

    try {
      const payload = JSON.stringify({
        streams: [
          {
            stream: this.labels,
            values: entries.map((entry) => [entry.timestamp, entry.line]),
          },
        ],
      });
      await postToLoki(this.host, payload);
    } catch {
      // silenceErrors — a missing/unreachable Loki must never break the app
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function buildTransports(): Transport[] {
  // In test environments attach a single silent transport so winston does
  // not warn about "no transports" while keeping tests free of file and
  // network I/O.
  if (NODE_ENV === "test") {
    return [new winston.transports.Console({ silent: true })];
  }

  const transports: Transport[] = [];

  transports.push(
    new winston.transports.Console({
      format: USE_PRETTY_STDOUT ? prettyFormat : jsonFormat,
    }),
  );

  // Rotating file transport — inherits the scrubbed JSON format. Shards by
  // date, rotates by size, gzip-compresses old shards, and keeps only the
  // configured retention window.
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    transports.push(
      new DailyRotateFile({
        dirname: LOG_DIR,
        filename: "app-%DATE%.log",
        datePattern: "YYYY-MM-DD-HH-mm-ss",
        maxSize: LOG_FILE_SIZE,
        maxFiles: String(LOG_FILE_RETENTION),
        zippedArchive: true,
      }),
    );
  } catch (err) {
    // A missing/writable log directory must never crash the process — the
    // stdout transport still captures everything.
    console.warn("[logger] Failed to initialise rotating file transport:", err);
  }

  const lokiHost = process.env.LOKI_HOST;
  if (lokiHost) {
    transports.push(
      new LokiTransport({
        host: lokiHost,
        labels: {
          service: SERVICE_NAME,
          env: NODE_ENV,
        },
      }),
    );
  }

  return transports;
}

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

export interface RelaxedLogMethods {
  fatal(msg: string | object, ...args: unknown[]): void;
  error(msg: string | object, ...args: unknown[]): void;
  warn(msg: string | object, ...args: unknown[]): void;
  info(msg: string | object, ...args: unknown[]): void;
  debug(msg: string | object, ...args: unknown[]): void;
  trace(msg: string | object, ...args: unknown[]): void;
  security(msg: string | object, ...args: unknown[]): void;
  audit(msg: string | object, ...args: unknown[]): void;
}

export interface RelaxedLogger extends RelaxedLogMethods {
  level: string;
  child(bindings: Record<string, unknown>): RelaxedLogger;
}

/**
 * Thin wrapper that exposes the relaxed call signature used across the
 * codebase (`logger.info({ fields }, "message")` as well as
 * `logger.info("message", { fields })`) on top of a winston Logger.
 */
class WinstonLogger implements RelaxedLogger {
  private readonly core: winston.Logger;

  constructor(core: winston.Logger) {
    this.core = core;
  }

  get level(): string {
    return this.core.level;
  }

  set level(level: string) {
    this.core.level = level;
  }

  child(bindings: Record<string, unknown>): RelaxedLogger {
    return new WinstonLogger(this.core.child(bindings));
  }

  fatal(...args: [string | object, ...unknown[]]): void {
    this.write("error", args);
  }

  error(...args: [string | object, ...unknown[]]): void {
    this.write("error", args);
  }

  warn(...args: [string | object, ...unknown[]]): void {
    this.write("warn", args);
  }

  info(...args: [string | object, ...unknown[]]): void {
    this.write("info", args);
  }

  debug(...args: [string | object, ...unknown[]]): void {
    this.write("debug", args);
  }

  trace(...args: [string | object, ...unknown[]]): void {
    this.write("trace", args);
  }

  security(...args: [string | object, ...unknown[]]): void {
    this.write("security", args);
  }

  audit(...args: [string | object, ...unknown[]]): void {
    this.write("audit", args);
  }

  private write(level: string, args: [string | object, ...unknown[]]): void {
    const { message, meta } = normalizeArgs(args);
    this.core.log(level, message, meta);
  }
}

const winstonLogger = winston.createLogger({
  levels: LOG_LEVELS,
  level: ACTIVE_LOG_LEVEL,
  format: jsonFormat,
  transports: buildTransports(),
});

const logger: RelaxedLogger = new WinstonLogger(winstonLogger);

export default logger;

/**
 * Create a child logger pre-bound with a trace_id.
 * Use this in request handlers to propagate distributed trace context:
 *
 *   const reqLogger = childLogger(req.headers['x-trace-id'] as string);
 *   reqLogger.info({ path: req.path }, 'incoming request');
 */
export function childLogger(
  traceId: string,
  extra?: Record<string, unknown>,
): RelaxedLogger {
  return new WinstonLogger(
    winstonLogger.child({ trace_id: traceId, ...extra }),
  );
}

// ---------------------------------------------------------------------------
// Telecom Latency Tracking & Audit Logging
// ---------------------------------------------------------------------------

export interface TelecomLatencyMetric {
  provider: string;
  operation: string;
  durationMs: number;
  success: boolean;
  country?: string;
  statusCode?: number;
  endpoint?: string;
  timestamp?: string;
}

export interface TelecomOperationStats {
  operation: string;
  count: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

export interface TelecomProviderMetricsSummary {
  provider: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  overallAvgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  operations: Record<string, TelecomOperationStats>;
}

const AUDIT_LOG_DIR = path.join(LOG_DIR, "audit");
export const TELECOM_METRICS_LOG_FILE = path.join(
  AUDIT_LOG_DIR,
  "telecom-metrics.log",
);

const telecomLatencyStore: TelecomLatencyMetric[] = [];
const MAX_STORE_ENTRIES = 5000;

function ensureAuditLogDirectory(): void {
  try {
    if (!fs.existsSync(AUDIT_LOG_DIR)) {
      fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    }
  } catch (err) {
    logger.error({ err }, "Failed to create audit log directory:");
  }
}

/**
 * Record round-trip response time for telecom provider requests.
 * Writes performance metrics to the audit log folder (logs/audit/telecom-metrics.log),
 * updates in-memory store for admin metrics API, and logs via the structured logger.
 */
export function recordTelecomLatency(metric: TelecomLatencyMetric): void {
  const timestamp = metric.timestamp ?? new Date().toISOString();
  const entry: TelecomLatencyMetric = {
    ...metric,
    timestamp,
    durationMs: Math.max(0, Math.round(metric.durationMs * 100) / 100),
  };

  // ── Prometheus metrics ──────────────────────────────────────────────────
  const durationSeconds = entry.durationMs / 1_000;
  momoProviderRequestDurationSeconds.observe(
    { provider: entry.provider, operation: entry.operation },
    durationSeconds,
  );

  if (!entry.success) {
    let errorType = "unknown";
    const code = entry.statusCode;
    if (code) {
      if (code === 408 || code === 504) errorType = "timeout";
      else if (code >= 400 && code < 500) errorType = "http_4xx";
      else if (code >= 500) errorType = "http_5xx";
    } else if (entry.durationMs >= (metric as any).timeoutMs) {
      errorType = "timeout";
    } else {
      errorType = "network";
    }
    momoProviderErrorsTotal.inc({ provider: entry.provider, error_type: errorType });
  }
  // ────────────────────────────────────────────────────────────────────────

  telecomLatencyStore.push(entry);
  if (telecomLatencyStore.length > MAX_STORE_ENTRIES) {
    telecomLatencyStore.shift();
  }

  ensureAuditLogDirectory();

  try {
    const logLine = JSON.stringify(entry) + "\n";
    fs.appendFileSync(TELECOM_METRICS_LOG_FILE, logLine, "utf8");
  } catch (err) {
    logger.error({ err }, "Failed to write to telecom audit log file:");
  }

  logger.info(
    {
      type: "telecom_latency_metric",
      ...entry,
    },
    `Telecom API latency: ${entry.provider} - ${entry.operation} took ${entry.durationMs}ms`,
  );
}

/**
 * Retrieve aggregated telecom latency metrics including average response times overall
 * and broken down per operation. Reads from in-memory store and falls back to
 * reading the audit log file if in-memory store is empty.
 */
export function getTelecomAverageMetrics(
  providerFilter?: string,
): TelecomProviderMetricsSummary {
  let records: TelecomLatencyMetric[] = [...telecomLatencyStore];

  if (records.length === 0 && fs.existsSync(TELECOM_METRICS_LOG_FILE)) {
    try {
      const fileContent = fs.readFileSync(TELECOM_METRICS_LOG_FILE, "utf8");
      const lines = fileContent.split("\n").filter((l) => l.trim().length > 0);
      records = lines.map((line) => JSON.parse(line));
    } catch (err) {
      logger.error({ err }, "Error reading telecom audit log file:");
    }
  }

  if (providerFilter) {
    const filterLower = providerFilter.toLowerCase();
    records = records.filter((r) => r.provider.toLowerCase() === filterLower);
  }

  const totalRequests = records.length;
  if (totalRequests === 0) {
    return {
      provider: providerFilter ?? "all",
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      overallAvgDurationMs: 0,
      minDurationMs: 0,
      maxDurationMs: 0,
      operations: {},
    };
  }

  let totalDuration = 0;
  let successCount = 0;
  let errorCount = 0;
  let minDurationMs = Infinity;
  let maxDurationMs = -Infinity;

  const opGroupMap: Record<string, TelecomLatencyMetric[]> = {};

  for (const r of records) {
    totalDuration += r.durationMs;
    if (r.success) {
      successCount++;
    } else {
      errorCount++;
    }

    if (r.durationMs < minDurationMs) minDurationMs = r.durationMs;
    if (r.durationMs > maxDurationMs) maxDurationMs = r.durationMs;

    const opKey = r.operation || "unknown";
    if (!opGroupMap[opKey]) {
      opGroupMap[opKey] = [];
    }
    opGroupMap[opKey].push(r);
  }

  const operations: Record<string, TelecomOperationStats> = {};
  for (const [opKey, opRecords] of Object.entries(opGroupMap)) {
    let opTotalDuration = 0;
    let opSuccess = 0;
    let opError = 0;
    let opMin = Infinity;
    let opMax = -Infinity;

    for (const r of opRecords) {
      opTotalDuration += r.durationMs;
      if (r.success) opSuccess++;
      else opError++;

      if (r.durationMs < opMin) opMin = r.durationMs;
      if (r.durationMs > opMax) opMax = r.durationMs;
    }

    operations[opKey] = {
      operation: opKey,
      count: opRecords.length,
      successCount: opSuccess,
      errorCount: opError,
      avgDurationMs:
        Math.round((opTotalDuration / opRecords.length) * 100) / 100,
      minDurationMs: opMin === Infinity ? 0 : Math.round(opMin * 100) / 100,
      maxDurationMs: opMax === -Infinity ? 0 : Math.round(opMax * 100) / 100,
    };
  }

  return {
    provider: providerFilter ?? "all",
    totalRequests,
    successCount,
    errorCount,
    overallAvgDurationMs:
      Math.round((totalDuration / totalRequests) * 100) / 100,
    minDurationMs:
      minDurationMs === Infinity ? 0 : Math.round(minDurationMs * 100) / 100,
    maxDurationMs:
      maxDurationMs === -Infinity ? 0 : Math.round(maxDurationMs * 100) / 100,
    operations,
  };
}

/**
 * Clears in-memory metrics store (useful for testing).
 */
export function clearTelecomMetricsStore(): void {
  telecomLatencyStore.length = 0;
}
