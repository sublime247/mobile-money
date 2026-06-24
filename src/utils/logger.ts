import fs from 'fs';
import path from 'path';
import os from 'os';
import pino, { DestinationStream, Level, Logger, StreamEntry } from 'pino';
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
type RotatingStreamFactory = (
  filename: string | ((time: number | Date, index?: number) => string),
  options?: {
    compress?: 'gzip';
    history?: string;
    maxFiles?: number;
    path?: string;
    size?: string;
  },
) => DestinationStream;

const { createStream } = require('rotating-file-stream') as {
  createStream: RotatingStreamFactory;
};

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info') as Level;
const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs');
const LOG_FILE_SIZE = process.env.LOG_FILE_SIZE ?? '10M';
const configuredRetention = Number(process.env.LOG_FILE_RETENTION ?? 14);
const LOG_FILE_RETENTION = Number.isFinite(configuredRetention) ? configuredRetention : 14;

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

function formatShardDate(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function logFileName(time: number | Date, index?: number): string {
  if (!time) {
    return 'app.log';
  }

  const shardDate = formatShardDate(time instanceof Date ? time : new Date(time));
  const shardIndex = index ? `.${index}` : '';

  return `app-${shardDate}${shardIndex}.log`;
}

function ensureLogDirectory(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function buildFileStream(): DestinationStream {
  ensureLogDirectory();

  return createStream(logFileName, {
    path: LOG_DIR,
    size: LOG_FILE_SIZE,
    compress: 'gzip',
    maxFiles: LOG_FILE_RETENTION,
    history: 'app.log.history',
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
  if (process.env.NODE_ENV === 'test') {
    return undefined;
  }

  const streams: StreamEntry[] = [
    {
      level: LOG_LEVEL,
      stream: process.stdout,
    },
    {
      level: LOG_LEVEL,
      stream: buildFileStream(),
    },
  ];

  if (lokiHost) {
    streams.push({
      // pino-loki runs in a worker thread — fully async, non-blocking
      level: LOG_LEVEL,
      stream: pino.transport({
        target: 'pino-loki',
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
      }),
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
  streams ? pino.multistream(streams, { dedupe: true }) : undefined,
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
