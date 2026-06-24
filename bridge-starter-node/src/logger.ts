/**
 * Structured Pino logger for bridge-starter-node.
 *
 * Every log line is emitted as a single JSON object containing:
 *   - time        ISO-8601 timestamp
 *   - level       uppercase label (INFO, WARN, ERROR, DEBUG)
 *   - service     constant "bridge-starter-node"
 *   - env         NODE_ENV value
 *   - msg         human-readable message
 *   - ...context  any extra fields passed by the caller
 *
 * Transport:
 *   - Production / CI  → raw JSON to stdout (pipe to log aggregator)
 *   - Development      → pino-pretty for human-readable coloured output
 *                        (enabled when LOG_PRETTY=true or NODE_ENV=development)
 *
 * Log level is controlled by the LOG_LEVEL env var (default: "info").
 * Valid values: trace | debug | info | warn | error | fatal
 *
 * Usage:
 *   import logger from './logger';
 *
 *   logger.info('Server started');
 *   logger.info({ port: 3000 }, 'Server started');
 *   logger.error({ err }, 'Payment failed');
 *
 *   // Child logger — binds extra fields to every line in a scope
 *   const reqLog = logger.child({ requestId: req.headers['x-request-id'] });
 *   reqLog.info({ method: req.method, path: req.path }, 'Incoming request');
 */

import pino, { type Logger, type TransportSingleOptions } from "pino";

const SERVICE_NAME = "bridge-starter-node";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

const isDev =
  process.env.NODE_ENV === "development" || process.env.LOG_PRETTY === "true";

/**
 * In development, route output through pino-pretty for readable logs.
 * In all other environments write raw JSON so log aggregators (Loki,
 * Datadog, CloudWatch, etc.) can parse the lines without transformation.
 */
function buildTransport(): TransportSingleOptions | undefined {
  if (!isDev) return undefined;

  return {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard", // human-readable local time in dev
      ignore: "pid,hostname",        // reduce noise in terminal output
    },
  };
}

const transport = buildTransport();

const logger: Logger = pino(
  {
    level: LOG_LEVEL,

    // Bind service name and environment to every log line so log aggregators
    // can filter by service without parsing the message field.
    base: {
      service: SERVICE_NAME,
      env: process.env.NODE_ENV ?? "development",
    },

    // Emit level as an uppercase string label (INFO, WARN, …) to match the
    // convention used by the main mobile-money-api service.
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },

    // ISO-8601 timestamps — compatible with Loki, ELK, and CloudWatch.
    timestamp: pino.stdTimeFunctions.isoTime,

    // Redact common sensitive fields so they are never written to any sink.
    // Extend this list as new sensitive fields are introduced.
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        "*.headers.authorization",
        "req.headers.authorization",
        "apiKey",
        "*.apiKey",
        "secret",
        "*.secret",
        "password",
        "*.password",
        "token",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  },
  transport ? pino.transport(transport) : undefined,
);

export default logger;

/**
 * Create a child logger pre-bound with a set of fields.
 * Use this inside request handlers to attach a request-scoped trace ID
 * to every log line without passing the logger explicitly:
 *
 *   const reqLog = childLogger({ requestId: req.headers['x-request-id'] });
 *   reqLog.info({ method: req.method }, 'Incoming request');
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
