/**
 * Server-Sent Events stream for transaction progress.
 *
 * Every published event gets a monotonic sequence id. The most recent events
 * are retained in a bounded ring buffer so a client that reconnects with a
 * `Last-Event-ID` header can replay everything it missed while it was
 * disconnected, in order, without the server holding per-client state.
 *
 * When the requested id has already been evicted from the ring buffer (client
 * was away longer than the buffer window), the stream emits a `stream-gap`
 * control event describing what was lost before replaying what remains, so the
 * client knows its view is incomplete instead of silently missing events.
 */
import { EventEmitter } from "events";
import type { Request, Response } from "express";

/** Event name used for live/replayed transaction events. Deliberately omitted
 *  from the frame so plain `EventSource.onmessage` consumers receive it. */
const TRANSACTION_EVENT = "transaction-event";

const DEFAULT_REPLAY_BUFFER_SIZE = 100;
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_RETRY_MS = 3000;

export interface TransactionStreamEvent {
  transactionId: string;
  /** Owner of the transaction. Events are only delivered to that user. */
  userId?: string;
  status?: string;
  step?: string;
  message?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface BufferedTransactionEvent extends TransactionStreamEvent {
  id: number;
  timestamp: number;
}

export type LastEventId =
  | { kind: "absent" }
  | { kind: "invalid"; raw: string }
  | { kind: "valid"; value: number };

export interface ReplayResult {
  /** Retained events with `id > lastEventId`, oldest first. */
  events: BufferedTransactionEvent[];
  /** Set when the requested id predates the oldest retained event. */
  gap: { requestedId: number; oldestRetainedId: number } | null;
}

export interface TransactionStreamStats {
  connections: number;
  listeners: number;
  heartbeats: number;
  bufferedEvents: number;
  nextEventId: number;
}

export interface TransactionStreamClient {
  userId: string;
  transactionId?: string;
}

const emitter = new EventEmitter();
// One listener per open stream; connections are tracked explicitly via
// getTransactionStreamStats() rather than by warning thresholds.
emitter.setMaxListeners(0);

let buffer: BufferedTransactionEvent[] = [];
let nextEventId = 1;
const activeConnections = new Set<symbol>();
const heartbeatTimers = new Set<NodeJS.Timeout>();

function envInt(name: string, fallback: number, min = 1): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

/** Capacity of the replay ring buffer — overridable for tests/deployments. */
export function replayBufferSize(): number {
  return envInt("SSE_REPLAY_BUFFER_SIZE", DEFAULT_REPLAY_BUFFER_SIZE);
}

/**
 * Appends an event to the ring buffer and broadcasts it to connected streams.
 * Synchronous: subscribers observe the event before this function returns,
 * which lets streams replay from a snapshot without a subscribe/replay race.
 */
export function publishTransactionEvent(
  event: TransactionStreamEvent,
): BufferedTransactionEvent {
  const buffered: BufferedTransactionEvent = {
    ...event,
    id: nextEventId++,
    timestamp: event.timestamp ?? Date.now(),
  };

  buffer.push(buffered);
  const capacity = replayBufferSize();
  if (buffer.length > capacity) {
    buffer.splice(0, buffer.length - capacity);
  }

  emitter.emit(TRANSACTION_EVENT, buffered);
  return buffered;
}

/**
 * Parses the `Last-Event-ID` request header.
 * Anything that is not a non-negative safe integer is reported as invalid
 * rather than guessed at — a corrupt client id must not crash the stream.
 */
export function parseLastEventId(
  header: string | string[] | undefined,
): LastEventId {
  if (header === undefined) return { kind: "absent" };

  const raw =
    (Array.isArray(header) ? header[header.length - 1] : header) ?? "";
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid", raw: trimmed };

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { kind: "invalid", raw: trimmed };
  return { kind: "valid", value };
}

/**
 * Events a client with `lastEventId` still needs, plus a gap notice when the
 * requested position has already been evicted from the ring buffer.
 */
export function getReplayEvents(lastEventId: number): ReplayResult {
  if (buffer.length === 0) return { events: [], gap: null };

  const oldestRetainedId = buffer[0].id;
  if (lastEventId < oldestRetainedId - 1) {
    return {
      events: [...buffer],
      gap: { requestedId: lastEventId, oldestRetainedId },
    };
  }

  return { events: buffer.filter((e) => e.id > lastEventId), gap: null };
}

/** Live + buffered event counts, and the listener/timer bookkeeping used to
 *  assert that disconnected clients leave nothing behind. */
export function getTransactionStreamStats(): TransactionStreamStats {
  return {
    connections: activeConnections.size,
    listeners: emitter.listenerCount(TRANSACTION_EVENT),
    heartbeats: heartbeatTimers.size,
    bufferedEvents: buffer.length,
    nextEventId,
  };
}

/**
 * Drops all buffered events, listeners, heartbeats and the id counter.
 * For tests and process teardown — production code never needs it.
 */
export function resetTransactionEventStream(): void {
  for (const timer of heartbeatTimers) clearInterval(timer);
  heartbeatTimers.clear();
  activeConnections.clear();
  emitter.removeAllListeners();
  buffer = [];
  nextEventId = 1;
}

function isEventVisible(
  event: BufferedTransactionEvent,
  client: TransactionStreamClient,
): boolean {
  if (client.transactionId && event.transactionId !== client.transactionId) {
    return false;
  }
  if (event.userId) return event.userId === client.userId;
  // Ownerless events are only shown to a client that explicitly subscribed to
  // that exact transaction (whose ownership was verified at connect time).
  return Boolean(client.transactionId);
}

function encodeEventFrame(event: BufferedTransactionEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function encodeControlFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Upgrades `res` to an SSE stream: replays missed events for
 * `Last-Event-ID`, then delivers live events until the client disconnects.
 * All per-connection state (listener + heartbeat timer) is released on close.
 */
export function attachTransactionStream(
  req: Request,
  res: Response,
  client: TransactionStreamClient,
): void {
  const token = Symbol("transaction-stream");
  activeConnections.add(token);
  let closed = false;

  const write = (frame: string): void => {
    if (closed || res.writableEnded) return;
    try {
      res.write(frame);
    } catch {
      cleanup();
    }
  };

  const onEvent = (event: BufferedTransactionEvent): void => {
    if (isEventVisible(event, client)) write(encodeEventFrame(event));
  };

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Bypass proxy buffering so frames reach the client immediately.
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Subscribe before replaying. publish() is synchronous, so there is no
  // window in which an event could be neither replayed nor delivered live.
  emitter.on(TRANSACTION_EVENT, onEvent);
  write(`retry: ${envInt("SSE_RETRY_MS", DEFAULT_RETRY_MS)}\n: connected\n\n`);

  const lastEventId = parseLastEventId(req.headers["last-event-id"]);
  if (lastEventId.kind === "invalid") {
    write(
      `: invalid last-event-id "${lastEventId.raw}", resuming live stream\n\n`,
    );
  } else if (lastEventId.kind === "valid") {
    const { events, gap } = getReplayEvents(lastEventId.value);
    if (gap) write(encodeControlFrame("stream-gap", gap));
    for (const event of events) {
      if (isEventVisible(event, client)) write(encodeEventFrame(event));
    }
  }

  const heartbeat = setInterval(
    () => {
      write(": ping\n\n");
    },
    envInt("SSE_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
  );
  heartbeat.unref?.();
  heartbeatTimers.add(heartbeat);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    heartbeatTimers.delete(heartbeat);
    emitter.off(TRANSACTION_EVENT, onEvent);
    activeConnections.delete(token);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Connection already gone — nothing left to release.
      }
    }
  }

  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("close", cleanup);
  req.on("error", cleanup);
}
