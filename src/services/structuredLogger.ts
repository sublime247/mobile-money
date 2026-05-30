import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import { randomUUID } from "crypto";
import zlib from "zlib";
import { redact } from "../utils/redact";

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
  /** Stable per-process identifier: hostname:pid — used for distributed tracing */
  instance_id: string;
  /** Distributed trace identifier — populated from request context when available */
  trace_id: string;
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
const ROLLING_LOG_MAX_BYTES = Math.max(
  1024,
  Number(process.env.LOG_SHARD_MAX_BYTES || 5 * 1024 * 1024),
);
const ROLLING_LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LOG_SHARD_RETENTION_DAYS || 7),
);
const ROLLING_LOG_COMPRESS =
  process.env.LOG_SHARD_COMPRESS !== "false" &&
  process.env.LOG_SHARD_COMPRESS !== "0";
/** Stable per-process identifier used in every log line for distributed tracing */
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

let installed = false;
let fileStream: fs.WriteStream | null = null;
let rollingState: {
  initialized: boolean;
  currentDateKey: string;
  shardIndex: number;
  currentBytes: number;
} | null = null;

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
  error: Error & { code?: string | number; [key: string]: unknown },
): JsonRecord {
  const result: JsonRecord = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code !== undefined ? String(error.code) : undefined,
  };
  // Copy all enumerable own properties so that extra fields attached to the
  // Error (e.g. statusCode, details, token) are preserved for redaction.
  for (const key of Object.keys(error)) {
    if (!(key in result)) {
      result[key] = error[key];
    }
  }
  return result;
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

function isRollingLogMirrorEnabled(): boolean {
  return SERVICE_ENVIRONMENT !== "production" && DEFAULT_LOG_FILE_PATH !== "/dev/null";
}

function getLogDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getLogShardPath(dateKey: string, shardIndex: number): string {
  const parsed = path.parse(DEFAULT_LOG_FILE_PATH);
  const shardName = `${parsed.name}-${dateKey}-shard-${String(shardIndex).padStart(4, "0")}${parsed.ext}`;
  return path.join(parsed.dir, shardName);
}

function ensureMirrorDirectory(): void {
  fs.mkdirSync(path.dirname(DEFAULT_LOG_FILE_PATH), { recursive: true });
}

function readCurrentLogSize(): number {
  try {
    return fs.statSync(DEFAULT_LOG_FILE_PATH).size;
  } catch {
    return 0;
  }
}

function compressShardIfNeeded(filePath: string): void {
  if (!ROLLING_LOG_COMPRESS || !fs.existsSync(filePath)) {
    return;
  }

  const gzPath = `${filePath}.gz`;
  const content = fs.readFileSync(filePath);
  fs.writeFileSync(gzPath, zlib.gzipSync(content));
  fs.unlinkSync(filePath);
}

function pruneOldCompressedShards(): void {
  const dir = path.dirname(DEFAULT_LOG_FILE_PATH);
  const parsed = path.parse(DEFAULT_LOG_FILE_PATH);
  const prefix = `${parsed.name}-`;
  const suffix = `${parsed.ext}.gz`;
  const retentionMs = ROLLING_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      let fileDate: number | null = null;

      const match = entry.name.match(/-(\d{4}-\d{2}-\d{2})-shard-/);
      if (match?.[1]) {
        const parsedDate = new Date(`${match[1]}T00:00:00.000Z`).getTime();
        if (!Number.isNaN(parsedDate)) {
          fileDate = parsedDate;
        }
      }

      const ageMs =
        fileDate !== null ? now - fileDate : now - fs.statSync(fullPath).mtimeMs;

      if (ageMs > retentionMs) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {
    // Best-effort cleanup only; never block logging.
  }
}

function rotateRollingShard(nextDateKey: string): void {
  if (!rollingState) {
    rollingState = {
      initialized: true,
      currentDateKey: nextDateKey,
      shardIndex: 1,
      currentBytes: readCurrentLogSize(),
    };
    return;
  }

  if (!fs.existsSync(DEFAULT_LOG_FILE_PATH)) {
    rollingState.currentBytes = 0;
    rollingState.currentDateKey = nextDateKey;
    rollingState.shardIndex = 1;
    return;
  }

  const currentSize = readCurrentLogSize();
  if (currentSize <= 0) {
    rollingState.currentBytes = 0;
    rollingState.currentDateKey = nextDateKey;
    rollingState.shardIndex = 1;
    return;
  }

  const previousDateKey = rollingState.currentDateKey;
  const previousShardIndex = rollingState.shardIndex;
  const shardPath = getLogShardPath(previousDateKey, previousShardIndex);
  fs.renameSync(DEFAULT_LOG_FILE_PATH, shardPath);
  compressShardIfNeeded(shardPath);
  pruneOldCompressedShards();

  rollingState.currentBytes = 0;
  rollingState.currentDateKey = nextDateKey;
  rollingState.shardIndex =
    previousDateKey === nextDateKey ? previousShardIndex + 1 : 1;
}

function writeRollingMirror(output: string): void {
  ensureMirrorDirectory();

  const nextBytes = Buffer.byteLength(output);
  const dateKey = getLogDateKey();
  const currentBytes = readCurrentLogSize();

  if (!rollingState) {
    rollingState = {
      initialized: true,
      currentDateKey: dateKey,
      shardIndex: 1,
      currentBytes,
    };
  }

  if (rollingState.currentDateKey !== dateKey) {
    rotateRollingShard(dateKey);
  } else if (
    currentBytes > 0 &&
    currentBytes + nextBytes > ROLLING_LOG_MAX_BYTES
  ) {
    rotateRollingShard(dateKey);
  }

  fs.appendFileSync(DEFAULT_LOG_FILE_PATH, output, "utf8");
  rollingState.currentBytes = readCurrentLogSize();
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
    instance_id:
      typeof merged.instance_id === "string" ? merged.instance_id : INSTANCE_ID,
    trace_id:
      typeof merged.trace_id === "string"
        ? merged.trace_id
        : typeof merged.traceId === "string"
          ? merged.traceId
          : randomUUID(),
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
    (arg): arg is Error & { code?: string | number; [key: string]: unknown } =>
      arg instanceof Error,
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

function writeLogMirror(output: string): void {
  if (isRollingLogMirrorEnabled()) {
    writeRollingMirror(output);
    return;
  }

  try {
    getLogStream().write(output);
  } catch {
    // Keep stdout/stderr logging alive even if the mirror file is unavailable.
  }
}

function writeEntry(level: LogLevel, args: unknown[]): void {
  const entry = buildStructuredLogEntry(level, args);
  // Redact sensitive fields before serialising — covers every log call site.
  const safeEntry = redact(entry) as typeof entry;
  const line = JSON.stringify(safeEntry);
  const output = `${line}\n`;

  if (level === "error" || level === "warn") {
    process.stderr.write(output);
  } else {
    process.stdout.write(output);
  }

  writeLogMirror(output);
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
  rollingState = null;

  if (!fileStream) {
    installed = false;
    return;
  }

  fileStream.end();
  fileStream = null;
  installed = false;
}

export function getStructuredLogMirrorMode(): "rolling" | "stream" {
  return isRollingLogMirrorEnabled() ? "rolling" : "stream";
}

export function getStructuredLogShardPath(
  dateKey: string,
  shardIndex: number,
): string {
  return getLogShardPath(dateKey, shardIndex);
}
