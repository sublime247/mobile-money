import path from "path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

export interface WinstonDailyRotateOptions {
  filename?: string;
  datePattern?: string;
  maxFiles?: string | number;
  maxSize?: string;
  level?: string;
  zippedArchive?: boolean;
  dirname?: string;
  auditFile?: string;
}

const DEFAULT_LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), "logs");
const DEFAULT_RETENTION = process.env.LOG_FILE_RETENTION ?? "14d";

const REDACTED = "[REDACTED]";
const SENSITIVE_LOG_KEYS = new Set([
  "password",
  "secret",
  "token",
  "privatekey",
  "private_key",
  "nationalid",
  "national_id",
  "phone",
  "phonenumber",
  "phone_number",
  "msisdn",
]);

function maskString(value: string): string {
  return value
    .replace(/\+2376\d*(\d{2})\b/g, "+2376****$1")
    .replace(/\bS[A-Z2-7]{55}\b/g, REDACTED)
    .replace(/\b(password|secret|token|private[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=" + REDACTED);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_LOG_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(nested),
    ]),
  );
}

const redactSensitiveData = winston.format((info) => {
  for (const [key, value] of Object.entries(info)) {
    info[key] = SENSITIVE_LOG_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactValue(value);
  }
  return info;
});

/**
 * Creates a Winston DailyRotateFile transport helper configured with default 14-day retention limits
 * and clean date-stamped log file formatting.
 */
export function createDailyRotateTransport(
  options: WinstonDailyRotateOptions = {},
): DailyRotateFile {
  const dirname = options.dirname ?? DEFAULT_LOG_DIR;
  const filename = options.filename ?? "app-%DATE%.log";
  const datePattern = options.datePattern ?? "YYYY-MM-DD";
  const maxFiles = options.maxFiles ?? DEFAULT_RETENTION;
  const maxSize = options.maxSize ?? "20m";
  const zippedArchive = options.zippedArchive ?? true;

  return new DailyRotateFile({
    dirname,
    filename,
    datePattern,
    maxFiles,
    maxSize,
    zippedArchive,
    level: options.level,
    auditFile:
      options.auditFile ??
      path.join(dirname, `${path.parse(filename).name}-audit.json`),
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
    ),
  });
}

/**
 * Creates a pre-configured Winston logger with rotation policies for combined and error log files.
 * Enforces 14-day retention limits and generates clean date-stamped log files.
 */
export function createWinstonRotateLogger(options?: {
  logDir?: string;
  logLevel?: string;
  maxFiles?: string | number;
}): winston.Logger {
  const logDir = options?.logDir ?? DEFAULT_LOG_DIR;
  const logLevel = options?.logLevel ?? process.env.LOG_LEVEL ?? "info";
  const maxFiles = options?.maxFiles ?? DEFAULT_RETENTION;

  const appTransport = createDailyRotateTransport({
    dirname: logDir,
    filename: "app-%DATE%.log",
    datePattern: "YYYY-MM-DD",
    maxFiles,
    level: logLevel,
  });

  const errorTransport = createDailyRotateTransport({
    dirname: logDir,
    filename: "error-%DATE%.log",
    datePattern: "YYYY-MM-DD",
    maxFiles,
    level: "error",
  });

  const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
    ),
  });

  return winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      appTransport,
      errorTransport,
      ...(process.env.NODE_ENV !== "test" ? [consoleTransport] : []),
    ],
  });
}

const defaultWinstonLogger = createWinstonRotateLogger();
export default defaultWinstonLogger;
