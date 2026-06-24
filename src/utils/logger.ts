import pino, { Logger, TransportTargetOptions } from 'pino';
import os from 'os';
import { REDACT_KEYS } from './redact';

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

const SERVICE_NAME = process.env.SERVICE_NAME ?? 'mobile-money-api';
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

/**
 * Build the pino transport targets array.
 *
 * stdout is always included.  The Loki target is added only when LOKI_HOST
 * is present in the environment, keeping CI and local dev working without
 * any external sink.
 */
function buildTransports(): pino.TransportMultiOptions | undefined {
  const lokiHost = process.env.LOKI_HOST;

  // In test environments skip all transports — tests use the raw pino
  // instance and should not attempt network connections.
  if (process.env.NODE_ENV === 'test') {
    return undefined;
  }

  const targets: TransportTargetOptions[] = [
    {
      target: 'pino/file',
      level: LOG_LEVEL,
      options: { destination: 1 }, // fd 1 = stdout
    },
  ];

  if (lokiHost) {
    targets.push({
      // pino-loki runs in a worker thread — fully async, non-blocking
      target: 'pino-loki',
      level: LOG_LEVEL,
      options: {
        host: lokiHost,
        // Gracefully handle connection failures — never throw into the app
        silenceErrors: true,
        labels: {
          service: SERVICE_NAME,
          env: process.env.NODE_ENV ?? 'development',
        },
        // Batch up to 10 log lines or flush every 5 s, whichever comes first
        batching: true,
        interval: 5,
      },
    });
  }

  // Only wrap in multi-transport when we have more than one target
  if (targets.length === 1) {
    return undefined; // let pino default to stdout
  }

  return {
    targets,
  };
}

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

const transport = buildTransports();

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

    // Format the level as uppercase string for Loki/Grafana label filters
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },

    // Redact sensitive fields before any transport sees them
    redact: {
      paths: [
        ...REDACT_KEYS,
        ...REDACT_KEYS.map((key) => `*.${key}`),
        ...REDACT_KEYS.map((key) => `req.headers.${key}`),
        ...REDACT_KEYS.map((key) => `*.req.headers.${key}`),
      ],
      censor: '[REDACTED]',
    },

    // ISO-8601 timestamps
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport ? pino.transport(transport) : undefined,
);

export default logger;

/**
 * Create a child logger pre-bound with a trace_id.
 * Use this in request handlers to propagate distributed trace context:
 *
 *   const reqLogger = childLogger(req.headers['x-trace-id'] as string);
 *   reqLogger.info({ path: req.path }, 'incoming request');
 */
export function childLogger(traceId: string, extra?: Record<string, unknown>): Logger {
  return logger.child({ trace_id: traceId, ...extra });
}
