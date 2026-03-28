import fs from "fs";
import os from "os";
import path from "path";
import util from "util";

type LogLevel = "debug" | "info" | "warn" | "error";

type JsonRecord = Record<string, unknown>;

interface StructuredError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

interface StructuredLogEntry extends JsonRecord {
  "@timestamp": string;
  message: string;
  log: {
    level: LogLevel;
  };
  service: {
    name: string;
    environment: string;
  };
  host: {
    hostname: string;
  };
  process: {
    pid: number;
  };
  ecs: {
    version: string;
  };
  event: JsonRecord & {
    dataset: string;
  };
}

const SERVICE_NAME = process.env.SERVICE_NAME || "mobile-money-api";
const SERVICE_ENVIRONMENT = process.env.NODE_ENV || "development";
const DEFAULT_LOG_FILE_PATH =
  process.env.LOG_FILE_PATH || path.join(process.cwd(), "logs", "app.log");

let installed = false;
let fileStream: fs.WriteStream | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJsonObject(value: string): JsonRecord | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeError(
  error: Error & { code?: string | number },
): StructuredError {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code !== undefined ? String(error.code) : undefined,
  };
}

function serializeUnknown(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeUnknown(item));
  }

  if (isRecord(value)) {
    return Object.entries(value).reduce<JsonRecord>((acc, [key, entry]) => {
      acc[key] = serializeUnknown(entry);
      return acc;
    }, {});
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function toMessage(args: unknown[]): string {
  const printable = args.map((arg) =>
    arg instanceof Error ? arg.message : serializeUnknown(arg),
  );
  return util.format(...printable).trim();
}

function inferDataset(entry: JsonRecord, rawEvent?: unknown): string {
  if (
    typeof entry.sessionId === "string" ||
    rawEvent === "session.ip_mismatch"
  ) {
    return "security.session";
  }

  if (typeof entry["event.dataset"] === "string") {
    return entry["event.dataset"];
  }

  const eventValue = entry.event;
  if (isRecord(eventValue) && typeof eventValue.dataset === "string") {
    return eventValue.dataset;
  }

  if (typeof entry.type === "string" && entry.type === "slow_query") {
    return "db.slow_query";
  }

  if (
    typeof entry.method === "string" &&
    (typeof entry.path === "string" || typeof entry.originalUrl === "string")
  ) {
    return "http.request";
  }

  return "application";
}

function normalizeLevel(level: LogLevel, entry: JsonRecord): LogLevel {
  const logValue = entry.log;
  if (isRecord(logValue) && typeof logValue.level === "string") {
    return (logValue.level.toLowerCase() as LogLevel) || level;
  }

  if (typeof entry.level === "string") {
    return (entry.level.toLowerCase() as LogLevel) || level;
  }

  return level;
}

function buildContext(args: unknown[]): unknown {
  if (args.length === 0) {
    return undefined;
  }

  if (args.length === 1) {
    return serializeUnknown(args[0]);
  }

  return args.map((arg) => serializeUnknown(arg));
}

function buildMergedEntry(args: unknown[]): JsonRecord {
  const merged: JsonRecord = {};

  for (const arg of args) {
    if (typeof arg === "string") {
      const parsed = tryParseJsonObject(arg);
      if (parsed) {
        Object.assign(merged, serializeUnknown(parsed));
      }
      continue;
    }

    if (arg instanceof Error) {
      continue;
    }

    if (isRecord(arg)) {
      Object.assign(merged, serializeUnknown(arg));
    }
  }

  return merged;
}

export function buildStructuredLogEntry(
  level: LogLevel,
  args: unknown[],
): StructuredLogEntry {
  const merged = buildMergedEntry(args);
  const normalizedLevel = normalizeLevel(level, merged);
  const timestamp =
    typeof merged.timestamp === "string"
      ? merged.timestamp
      : typeof merged["@timestamp"] === "string"
        ? String(merged["@timestamp"])
        : new Date().toISOString();

  delete merged.timestamp;
  delete merged["@timestamp"];
  delete merged.level;
  delete merged["event.dataset"];
  delete merged.log;

  const rawEvent = merged.event;
  delete merged.event;

  const context = buildContext(
    args.filter((arg) => {
      if (typeof arg !== "string") {
        return true;
      }

      return !tryParseJsonObject(arg);
    }),
  );

  const eventValue = isRecord(rawEvent) ? rawEvent : {};

  const entry: StructuredLogEntry = {
    "@timestamp": timestamp,
    message:
      typeof merged.message === "string" && merged.message.trim().length > 0
        ? merged.message
        : toMessage(args) || `console.${normalizedLevel}`,
    log: {
      level: normalizedLevel,
    },
    service: {
      name: SERVICE_NAME,
      environment: SERVICE_ENVIRONMENT,
    },
    host: {
      hostname: os.hostname(),
    },
    process: {
      pid: process.pid,
    },
    ecs: {
      version: "8.11.0",
    },
    event: {
      ...eventValue,
      dataset: inferDataset(merged, rawEvent),
    },
    ...merged,
  };

  if (typeof rawEvent === "string") {
    entry.event.action = rawEvent;
  }

  if (context !== undefined && !("context" in entry)) {
    entry.context = context;
  }

  const errorArg = args.find(
    (arg): arg is Error & { code?: string | number } => arg instanceof Error,
  );
  if (errorArg && entry.error === undefined) {
    entry.error = serializeError(errorArg);
  }

  return entry;
}

function getLogStream(): fs.WriteStream {
  if (fileStream) {
    return fileStream;
  }

  fs.mkdirSync(path.dirname(DEFAULT_LOG_FILE_PATH), { recursive: true });
  fileStream = fs.createWriteStream(DEFAULT_LOG_FILE_PATH, { flags: "a" });
  return fileStream;
}

function writeEntry(level: LogLevel, args: unknown[]): void {
  const entry = buildStructuredLogEntry(level, args);
  const line = JSON.stringify(entry);
  const output = `${line}\n`;

  if (level === "error" || level === "warn") {
    process.stderr.write(output);
  } else {
    process.stdout.write(output);
  }

  try {
    getLogStream().write(output);
  } catch {
    // Keep stdout/stderr logging alive even if the mirror file is unavailable.
  }
}

export function logStructured(level: LogLevel, entry: object): void {
  writeEntry(level, [entry]);
}

export function installGlobalLogger(): void {
  if (installed || process.env.NODE_ENV === "test") {
    return;
  }

  installed = true;

  console.debug = (...args: unknown[]) => writeEntry("debug", args);
  console.log = (...args: unknown[]) => writeEntry("info", args);
  console.info = (...args: unknown[]) => writeEntry("info", args);
  console.warn = (...args: unknown[]) => writeEntry("warn", args);
  console.error = (...args: unknown[]) => writeEntry("error", args);
}

export function closeStructuredLogStream(): void {
  if (!fileStream) {
    return;
  }

  fileStream.end();
  fileStream = null;
  installed = false;
}
