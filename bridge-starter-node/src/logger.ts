/**
 * Structured Pino logger for bridge-starter-node.
 *
 * Every log line is emitted as a single JSON object compatible with
 * ELK (Elasticsearch/Logstash/Kibana) and Datadog, containing:
 *   - timestamp      ISO-8601
 *   - level          uppercase label (INFO, WARN, ERROR, DEBUG)
 *   - service        constant "bridge-starter-node" (override with SERVICE_NAME)
 *   - environment    NODE_ENV value
 *   - correlationId  X-Correlation-ID of the current request, when present
 *   - message        human-readable message
 *   - ...context     any extra fields passed by the caller
 *
 * Sensitive fields (passwords, PINs, tokens, card numbers, ...) are redacted
 * at any nesting depth before the line is written.
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
import { AsyncLocalStorage } from "async_hooks";
import { redact } from "./utils/redact";

export const requestContext = new AsyncLocalStorage<{
  trace_id?: string;
  correlation_id?: string;
}>();

const SERVICE_NAME = process.env.SERVICE_NAME ?? "bridge-starter-node";
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
      messageKey: "message",
      timestampKey: "timestamp",
      translateTime: "SYS:standard", // human-readable local time in dev
      ignore: "pid,hostname", // reduce noise in terminal output
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
      environment: process.env.NODE_ENV ?? "development",
    },

    // ELK and Datadog index `message` by default.
    messageKey: "message",

    mixin() {
      const store = requestContext.getStore();
      const fields: Record<string, string> = {};
      if (store?.correlation_id) fields.correlationId = store.correlation_id;
      if (store?.trace_id) fields.trace_id = store.trace_id;
      return fields;
    },

    formatters: {
      // Emit level as an uppercase string label (INFO, WARN, …) to match the
      // convention used by the main mobile-money-api service.
      level: (label) => ({ level: label.toUpperCase() }),
      // Deep-redact sensitive keys and card numbers in every log payload.
      log: (object) => redact(object) as Record<string, unknown>,
    },

    // ISO-8601 `timestamp` field — compatible with Logstash and Datadog.
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,

    // Pino's path-based redaction also covers bindings added via child().
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        "*.headers.authorization",
        "req.headers.authorization",
        "req.headers.cookie",
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
