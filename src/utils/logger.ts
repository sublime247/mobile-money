import fs from "fs";
import path from "path";
import os from "os";
import pino, { DestinationStream, Level, Logger, StreamEntry } from "pino";
import { REDACT_KEYS } from "./redact";
import { AsyncLocalStorage } from "async_hooks";

export const requestContext = new AsyncLocalStorage<{ trace_id: string }>();

/**
 * Centralized Pino Logger — feature/centralized-logging
 *
 * Schema: every log line includes
 *   timestamp  – ISO-8601
 *   level      – uppercase string (INFO, ERROR, …)
 *   instance_id – hostname + PID, stable per process
 *   trace_id   – populated by callers via child() or log metadata
 *   service    – service name from SERVICE_NAME env var
 *
 * Transport:
 *   - Always writes to stdout (fallback / CI-safe)
 *   - Optionally ships to Loki via pino-loki when LOKI_HOST is set.
 *     The Loki transport runs in a worker thread (pino transport API) so
 *     log ingestion latency never blocks the event loop.
 *   - If LOKI_HOST is unreachable the transport silently drops and stdout
 *     continues — CI never fails due to a missing sink.
 *
 * Redaction: sensitive fields are replaced with [REDACTED] before any
 * transport sees them.
 */

const SERVICE_NAME = process.env.SERVICE_NAME ?? "mobile-money-api";
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
type RotatingStreamFactory = (
  filename: string | ((time: number | Date, index?: number) => string),
  options?: {
    compress?: "gzip";
    history?: string;
    maxFiles?: number;
    path?: string;
    size?: string;
  },
) => DestinationStream;

const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info") as Level;
const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), "logs");
const LOG_FILE_SIZE = process.env.LOG_FILE_SIZE ?? "10M";
const configuredRetention = Number(process.env.LOG_FILE_RETENTION ?? 14);
const LOG_FILE_RETENTION = Number.isFinite(configuredRetention)
  ? configuredRetention
  : 14;
const SCRUB_CENSOR = "[REDACTED]";

// ---------------------------------------------------------------------------
// Global regex scrub filters — applied inside every transport so secrets
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

type ScrubFilter = { pattern: RegExp; replacement: string };

function buildJsonKeyValueScrubFilters(keys: string[]): ScrubFilter[] {
  return keys.flatMap((key) => {
    const escaped = key.replace(/[_-]/g, "[_-]?");
    return [
      {
        pattern: new RegExp(
          `("${escaped}"\\s*:\\s*")([^"\\\\]*(?:\\\\.[^"\\\\]*)*)(")`,
          "gi",
        ),
        replacement: `$1${SCRUB_CENSOR}$3`,
      },
      {
        pattern: new RegExp(`('${escaped}'\\s*:\\s*')([^']*)(')`, "gi"),
        replacement: `$1${SCRUB_CENSOR}$3`,
      },
    ];
  });
}

const PII_SCRUB_REGEX_FILTERS: ScrubFilter[] = [
  ...buildJsonKeyValueScrubFilters([...REDACT_KEYS, ...PII_MASTER_KEY_FIELDS]),
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
];

const PII_KEY_VALUE_PATTERN =
  /\b(master[_-]?key|pii[_-]?master[_-]?key|db[_-]?encryption[_-]?key)\s*[=:]\s*['"]?[^\s'",}]+['"]?/gi;

function scrubLogOutput(chunk: string): string {
  let result = chunk.replace(
    PII_KEY_VALUE_PATTERN,
    (match, key: string) => `${key}=${SCRUB_CENSOR}`,
  );

  for (const { pattern, replacement } of PII_SCRUB_REGEX_FILTERS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Wrap any pino destination so regex scrubbing runs before the transport prints. */
function wrapStreamWithScrubbing(stream: DestinationStream): DestinationStream {
  return {
    write(msg: string) {
      stream.write(scrubLogOutput(msg));
    },
  };
}

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

function formatShardDate(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function logFileName(time: number | Date, index?: number): string {
  if (!time) {
    return "app.log";
  }

  const shardDate = formatShardDate(
    time instanceof Date ? time : new Date(time),
  );
  const shardIndex = index ? `.${index}` : "";

  return `app-${shardDate}${shardIndex}.log`;
}

function ensureLogDirectory(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function buildFileStream(): DestinationStream {
  ensureLogDirectory();

  const { createStream } = require("rotating-file-stream") as {
    createStream: RotatingStreamFactory;
  };

  return createStream(logFileName, {
    path: LOG_DIR,
    size: LOG_FILE_SIZE,
    compress: "gzip",
    maxFiles: LOG_FILE_RETENTION,
    history: "app.log.history",
  });
}

/**
 * Build the pino output stream array.
 *
 * stdout is always included. The local file stream rotates by size and gzip
 * compresses old shards. The Loki target is added only when LOKI_HOST is
 * present in the environment, keeping CI and local dev working without any
 * external sink.
 */
function buildStreams(): StreamEntry[] | undefined {
  const lokiHost = process.env.LOKI_HOST;

  // In test environments skip all transports — tests use the raw pino
  // instance and should not attempt network connections.
  if (process.env.NODE_ENV === "test") {
    return undefined;
  }

  const streams: StreamEntry[] = [
    {
      level: LOG_LEVEL,
      stream: wrapStreamWithScrubbing(process.stdout),
    },
    {
      level: LOG_LEVEL,
      stream: wrapStreamWithScrubbing(buildFileStream()),
    },
  ];

  if (lokiHost) {
    streams.push({
      // pino-loki runs in a worker thread — fully async, non-blocking
      level: LOG_LEVEL,
      stream: wrapStreamWithScrubbing(
        pino.transport({
          target: "pino-loki",
          options: {
            host: lokiHost,
            // Gracefully handle connection failures — never throw into the app
            silenceErrors: true,
            labels: {
              service: SERVICE_NAME,
              env: process.env.NODE_ENV ?? "development",
            },
            // Batch up to 10 log lines or flush every 5 s, whichever comes first
            batching: true,
            interval: 5,
          },
        }),
      ),
    });
  }

  return streams;
}

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

const streams = buildStreams();

const logger: Logger = pino(
  {
    level: LOG_LEVEL,

    // Custom levels for Security and Audit logs
    customLevels: {
      security: 35,
      audit: 45,
    },

    // Consistent JSON schema: every line carries timestamp, level,
    // instance_id, and service so distributed traces can be correlated.
    base: {
      service: SERVICE_NAME,
      instance_id: INSTANCE_ID,
    },

    mixin() {
      const store = requestContext.getStore();
      return store && store.trace_id ? { trace_id: store.trace_id } : {};
    },

    // Format the level as uppercase string for Loki/Grafana label filters
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },

    // Redact sensitive fields before any transport sees them
    redact: {
      paths: [
        ...REDACT_KEYS,
        ...PII_MASTER_KEY_FIELDS,
        ...REDACT_KEYS.map((key) => `*.${key}`),
        ...PII_MASTER_KEY_FIELDS.map((key) => `*.${key}`),
        ...REDACT_KEYS.map((key) => `req.headers.${key}`),
        ...REDACT_KEYS.map((key) => `*.req.headers.${key}`),
        ...PII_MASTER_KEY_FIELDS.map((key) => `req.headers.${key}`),
        ...PII_MASTER_KEY_FIELDS.map((key) => `*.req.headers.${key}`),
      ],
      censor: SCRUB_CENSOR,
    },

    // ISO-8601 timestamps
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  streams ? pino.multistream(streams, { dedupe: true }) : undefined,
);

export type RelaxedLogger = Omit<
  Logger,
  "fatal" | "error" | "warn" | "info" | "debug" | "trace"
> & {
  fatal: (msg: string | object, ...args: any[]) => void;
  error: (msg: string | object, ...args: any[]) => void;
  warn: (msg: string | object, ...args: any[]) => void;
  info: (msg: string | object, ...args: any[]) => void;
  debug: (msg: string | object, ...args: any[]) => void;
  trace: (msg: string | object, ...args: any[]) => void;
};

const relaxedLogger = logger as unknown as RelaxedLogger;
export default relaxedLogger;

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
): any {
  return logger.child({ trace_id: traceId, ...extra });
}
