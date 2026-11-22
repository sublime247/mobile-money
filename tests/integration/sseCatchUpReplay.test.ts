/**
 * Integration suite: SSE transaction stream catch-up replay.
 *
 * Status transitions are driven through the real `TransactionModel` (only the
 * database query layer is mocked) and delivered over the real HTTP route, so
 * the full production path — model → ring buffer → `Last-Event-ID` replay →
 * live tail — is exercised end to end instead of poking `publishTransactionEvent`
 * directly.
 *
 * Covers the reconnect contract: a client that drops mid-flight catches up on
 * exactly the events it missed, in order, with no duplicates or holes, and is
 * told about anything the bounded ring buffer already evicted.
 */
import express from "express";
import http from "http";
import { AddressInfo } from "net";

const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../src/config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
  querySmart: (...args: unknown[]) => mockQueryRead(...args),
  queryTransactionLogRead: (...args: unknown[]) => mockQueryRead(...args),
  pool: { query: jest.fn(), on: jest.fn() },
}));

import {
  TransactionModel,
  TransactionStatus,
} from "../../src/models/transaction";
import { transactionRoutes } from "../../src/routes/transactions";
import { generateToken } from "../../src/auth/jwt";
import {
  getTransactionStreamStats,
  resetTransactionEventStream,
  type TransactionStreamStats,
} from "../../src/services/transactionEventStream";

const OWNER_ID = "user-owner";
const OTHER_USER_ID = "user-other";
const OWNER_TX = "tx-owner";
const OTHER_TX = "tx-other";

interface DbRow {
  id: string;
  referenceNumber: string;
  providerReference: string | null;
  type: string;
  amount: string;
  phoneNumber: string | null;
  provider: string;
  stellarAddress: string | null;
  status: TransactionStatus;
  tags: string[];
  notes: string | null;
  adminNotes: string | null;
  metadata: Record<string, unknown>;
  locationMetadata: Record<string, unknown> | null;
  userId: string;
  idempotencyKey: string | null;
  idempotencyExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeRow(id: string, userId: string): DbRow {
  return {
    id,
    referenceNumber: `REF-${id.toUpperCase()}`,
    providerReference: null,
    type: "deposit",
    amount: "10000",
    phoneNumber: null,
    provider: "MTN",
    stellarAddress: null,
    status: TransactionStatus.Pending,
    tags: [],
    notes: null,
    adminNotes: null,
    metadata: {},
    locationMetadata: null,
    userId,
    idempotencyKey: null,
    idempotencyExpiresAt: null,
    createdAt: new Date("2026-06-01T10:00:00Z"),
    updatedAt: new Date("2026-06-01T10:00:00Z"),
  };
}

interface SseMessage {
  id?: number;
  event: string;
  data: string;
}

interface Waiter {
  check: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal SSE client over raw HTTP — streams never end on their own, so the
 *  client reads frames incrementally and exposes waiters for ordered
 *  assertions without arbitrary sleeps. */
class SseClient {
  status?: number;
  headers: http.IncomingHttpHeaders = {};
  raw = "";
  messages: SseMessage[] = [];

  private pending = "";
  private request?: http.ClientRequest;
  private waiters: Waiter[] = [];

  connect(
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const url = new URL(path, baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (res) => {
          this.status = res.statusCode;
          this.headers = res.headers;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            this.raw += chunk;
            this.consume(chunk);
          });
          res.on("end", () => this.rejectWaiters("stream ended"));
          res.on("error", () => this.rejectWaiters("stream error"));
          resolve();
        },
      );
      req.on("error", (err) => {
        this.rejectWaiters(err.message);
        reject(err);
      });
      req.end();
      this.request = req;
    });
  }

  waitFor(
    predicate: (message: SseMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<SseMessage> {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return this.wait(
      () => this.messages.some(predicate),
      `message matching predicate (received: ${JSON.stringify(this.messages)})`,
      timeoutMs,
    ).then(() => this.messages.find(predicate)!);
  }

  waitForMessages(count: number, timeoutMs = 5000): Promise<SseMessage[]> {
    if (this.messages.length >= count) {
      return Promise.resolve(this.messages.slice(0, count));
    }
    return this.wait(
      () => this.messages.length >= count,
      `${count} message(s) (received: ${JSON.stringify(this.messages)})`,
      timeoutMs,
    ).then(() => this.messages.slice(0, count));
  }

  close(): void {
    this.request?.destroy();
    this.request = undefined;
    this.rejectWaiters("client closed");
  }

  private wait(
    check: () => boolean,
    failure: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`Timed out waiting for ${failure}`));
      }, timeoutMs);
      this.waiters.push({
        check,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      this.settleWaiters();
    });
  }

  private settleWaiters(): void {
    const ready = this.waiters.filter((w) => w.check());
    this.waiters = this.waiters.filter((w) => !w.check());
    for (const waiter of ready) waiter.resolve();
  }

  private rejectWaiters(reason: string): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      waiter.reject(new Error(`SSE client stopped waiting: ${reason}`));
    }
  }

  private consume(chunk: string): void {
    this.pending += chunk;
    let boundary = this.pending.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 2);
      const message = parseFrame(frame);
      if (message) {
        this.messages.push(message);
        this.settleWaiters();
      }
      boundary = this.pending.indexOf("\n\n");
    }
  }
}

function parseFrame(frame: string): SseMessage | null {
  const lines = frame.split("\n");
  if (lines.every((line) => line.startsWith(":") || line.trim() === "")) {
    return null; // comment-only frame (heartbeat), nothing dispatched
  }

  let id: number | undefined;
  let event = "message";
  const dataLines: string[] = [];
  let hasData = false;

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

    if (field === "id") id = Number(value);
    else if (field === "event") event = value;
    else if (field === "data") {
      hasData = true;
      dataLines.push(value);
    }
  }

  // The EventSource spec dispatches nothing for frames without a data field.
  if (!hasData) return null;
  return { id, event, data: dataLines.join("\n") };
}

describe("SSE transaction stream catch-up replay (integration)", () => {
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  let model: TransactionModel;
  const openClients: SseClient[] = [];

  function seedTransactions(): void {
    const rows = new Map<string, DbRow>([
      [OWNER_TX, makeRow(OWNER_TX, OWNER_ID)],
      [OTHER_TX, makeRow(OTHER_TX, OTHER_USER_ID)],
    ]);

    mockQueryRead.mockImplementation(
      async (sql: string, params: unknown[]): Promise<unknown> => {
        if (sql.includes("FROM transactions WHERE id=")) {
          const row = rows.get(String(params[0]));
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    );

    mockQueryWrite.mockImplementation(
      async (sql: string, params: unknown[]): Promise<unknown> => {
        if (sql.startsWith("UPDATE transactions SET status=")) {
          const [status, id] = params as [TransactionStatus, string];
          const row = rows.get(id);
          if (!row) return { rows: [], rowCount: 0 };
          row.status = status;
          row.updatedAt = new Date();
          return {
            rows: [
              {
                user_id: row.userId,
                provider: row.provider,
                reference_number: row.referenceNumber,
                updated_at: row.updatedAt,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    );
  }

  async function openStream(
    options: {
      transactionId?: string;
      lastEventId?: string;
      userId?: string;
    } = {},
  ): Promise<SseClient> {
    const path = `/api/transactions/stream${
      options.transactionId
        ? `?transactionId=${encodeURIComponent(options.transactionId)}`
        : ""
    }`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${
        options.userId
          ? generateToken({
              userId: options.userId,
              email: `${options.userId}@example.com`,
              role: "merchant",
            })
          : token
      }`,
    };
    if (options.lastEventId !== undefined) {
      headers["Last-Event-ID"] = options.lastEventId;
    }

    const client = new SseClient();
    openClients.push(client);
    await client.connect(baseUrl, path, headers);
    return client;
  }

  async function waitForStats(
    predicate: (stats: TransactionStreamStats) => boolean,
    timeoutMs = 5000,
  ): Promise<TransactionStreamStats> {
    const deadline = Date.now() + timeoutMs;
    let stats = getTransactionStreamStats();
    while (!predicate(stats)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for stream stats, last seen: ${JSON.stringify(stats)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      stats = getTransactionStreamStats();
    }
    return stats;
  }

  /** One persisted status transition — returns the buffered event id. */
  async function transition(
    transactionId: string,
    status: TransactionStatus,
  ): Promise<number> {
    const updated = await model.updateStatus(transactionId, status);
    expect(updated).toBe(true);
    const stats = getTransactionStreamStats();
    return stats.nextEventId - 1;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret";
    token = generateToken({
      userId: OWNER_ID,
      email: "owner@example.com",
      role: "merchant",
    });

    seedTransactions();
    model = new TransactionModel();

    const app = express();
    app.use("/api/transactions", transactionRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of openClients) client.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.SSE_REPLAY_BUFFER_SIZE;
    delete process.env.SSE_HEARTBEAT_MS;
  });

  beforeEach(() => {
    resetTransactionEventStream();
    process.env.SSE_REPLAY_BUFFER_SIZE = "100";
    // Keep heartbeats out of the way of delivery assertions.
    process.env.SSE_HEARTBEAT_MS = "60000";
    mockQueryRead.mockReset();
    mockQueryWrite.mockReset();
    seedTransactions();
  });

  afterEach(() => {
    for (const client of openClients.splice(0)) client.close();
  });

  it("replays every transition missed while disconnected, then resumes live", async () => {
    const client = await openStream({ transactionId: OWNER_TX });
    expect(client.status).toBe(200);

    // One transition lands while the client is connected.
    const liveId = await transition(OWNER_TX, TransactionStatus.Processing);
    const live = await client.waitFor((m) => m.id === liveId);
    expect(JSON.parse(live.data)).toMatchObject({
      transactionId: OWNER_TX,
      userId: OWNER_ID,
      status: "processing",
    });

    // Client drops; these happen while it is away.
    client.close();
    await waitForStats((stats) => stats.connections === 0);

    const missedIds = [
      await transition(OWNER_TX, TransactionStatus.Completed),
      await transition(OWNER_TX, TransactionStatus.Reversed),
    ];

    const reconnected = await openStream({
      transactionId: OWNER_TX,
      lastEventId: String(liveId),
    });

    const replayed = await reconnected.waitForMessages(2);
    expect(replayed.map((m) => m.id)).toEqual(missedIds);
    expect(replayed.map((m) => JSON.parse(m.data).status)).toEqual([
      "completed",
      "reversed",
    ]);
    expect(replayed[0].id).toBe(liveId + 1);
    expect(reconnected.messages.some((m) => m.event === "stream-gap")).toBe(
      false,
    );

    // Live delivery picks up exactly where the replay ended.
    const afterId = await transition(OWNER_TX, TransactionStatus.ClawedBack);
    const after = await reconnected.waitFor((m) => m.id === afterId);
    expect(JSON.parse(after.data).status).toBe("clawed_back");
    expect(reconnected.messages.map((m) => m.id)).toEqual([
      ...missedIds,
      afterId,
    ]);
  });

  it("catches up over repeated reconnects without duplicates or holes", async () => {
    let cursor = 0;
    const seen: number[] = [];

    for (let round = 0; round < 4; round++) {
      const client = await openStream({
        transactionId: OWNER_TX,
        lastEventId: String(cursor),
      });

      // Everything published before this connection must arrive as backlog.
      const expected = seen.filter((id) => id > cursor);
      if (expected.length > 0) {
        const backlog = await client.waitForMessages(expected.length);
        expect(backlog.map((m) => m.id)).toEqual(expected);
      }

      const roundIds: number[] = [];
      for (let i = 0; i < 2; i++) {
        roundIds.push(await transition(OWNER_TX, TransactionStatus.Processing));
      }
      const delivered = await client.waitForMessages(
        expected.length + roundIds.length,
      );
      expect(delivered.map((m) => m.id)).toEqual([...expected, ...roundIds]);

      cursor = roundIds[roundIds.length - 1];
      seen.push(...roundIds);
      client.close();
      await waitForStats((stats) => stats.connections === 0);
    }

    // A client that missed the whole session catches up from its first cursor.
    const latecomer = await openStream({
      transactionId: OWNER_TX,
      lastEventId: "0",
    });
    const all = await latecomer.waitForMessages(seen.length);
    expect(all.map((m) => m.id)).toEqual(seen);
    expect(new Set(all.map((m) => m.id)).size).toBe(seen.length);
  });

  it("reports a stream-gap when the outage outlasted the ring buffer", async () => {
    process.env.SSE_REPLAY_BUFFER_SIZE = "4";

    const client = await openStream({ transactionId: OWNER_TX });
    const firstId = await transition(OWNER_TX, TransactionStatus.Processing);
    await client.waitFor((m) => m.id === firstId);
    client.close();
    await waitForStats((stats) => stats.connections === 0);

    // Ten transitions while away — ids 2..7 are evicted, 8..11 survive.
    for (let i = 0; i < 10; i++) {
      await transition(OWNER_TX, TransactionStatus.Processing);
    }
    expect(getTransactionStreamStats().bufferedEvents).toBe(4);

    const reconnected = await openStream({
      transactionId: OWNER_TX,
      lastEventId: String(firstId),
    });

    const messages = await reconnected.waitForMessages(5);
    expect(messages[0].event).toBe("stream-gap");
    expect(JSON.parse(messages[0].data)).toEqual({
      requestedId: firstId,
      oldestRetainedId: 8,
    });
    expect(messages.slice(1).map((m) => m.id)).toEqual([8, 9, 10, 11]);

    // The stream stays usable after the gap notice.
    const afterId = await transition(OWNER_TX, TransactionStatus.Completed);
    const after = await reconnected.waitFor((m) => m.id === afterId);
    expect(JSON.parse(after.data).status).toBe("completed");
    expect(reconnected.raw).not.toContain("id: 7\n");
  });

  it("replays only events the reconnecting client is entitled to see", async () => {
    const client = await openStream({ transactionId: OWNER_TX });
    const firstId = await transition(OWNER_TX, TransactionStatus.Processing);
    await client.waitFor((m) => m.id === firstId);
    client.close();
    await waitForStats((stats) => stats.connections === 0);

    // While away: another user's transaction churns, then ours advances.
    await transition(OTHER_TX, TransactionStatus.Processing);
    const ownerIds = [
      await transition(OWNER_TX, TransactionStatus.Completed),
      await transition(OWNER_TX, TransactionStatus.Reversed),
    ];
    await transition(OTHER_TX, TransactionStatus.Failed);

    const reconnected = await openStream({
      transactionId: OWNER_TX,
      lastEventId: String(firstId),
    });

    const replayed = await reconnected.waitForMessages(ownerIds.length);
    expect(replayed.map((m) => m.id)).toEqual(ownerIds);
    expect(
      replayed.every((m) => JSON.parse(m.data).transactionId === OWNER_TX),
    ).toBe(true);
    expect(reconnected.raw).not.toContain(OTHER_TX);
    expect(reconnected.raw).not.toContain(OTHER_USER_ID);
  });

  it("keeps concurrent transitions ordered, duplicate-free and gap-free", async () => {
    const client = await openStream({ transactionId: OWNER_TX });
    const firstId = await transition(OWNER_TX, TransactionStatus.Processing);
    await client.waitFor((m) => m.id === firstId);
    client.close();
    await waitForStats((stats) => stats.connections === 0);

    // Fan out several status writers at once while the client is offline.
    const statuses = [
      TransactionStatus.Completed,
      TransactionStatus.Reversed,
      TransactionStatus.ClawedBack,
      TransactionStatus.Review,
      TransactionStatus.Processing,
    ];
    await Promise.all(
      statuses.map((status) => model.updateStatus(OWNER_TX, status)),
    );
    const published = getTransactionStreamStats().nextEventId - 1;
    expect(published).toBe(firstId + statuses.length);

    const reconnected = await openStream({
      transactionId: OWNER_TX,
      lastEventId: String(firstId),
    });

    const replayed = await reconnected.waitForMessages(statuses.length);
    const ids = replayed.map((m) => m.id);
    expect(ids).toEqual(
      Array.from({ length: statuses.length }, (_, i) => firstId + 1 + i),
    );
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(reconnected.messages.some((m) => m.event === "stream-gap")).toBe(
      false,
    );

    // Reconnecting again at the tail replays nothing stale.
    const tailId = ids[ids.length - 1];
    reconnected.close();
    await waitForStats((stats) => stats.connections === 0);
    const tail = await openStream({
      transactionId: OWNER_TX,
      lastEventId: String(tailId),
    });
    const afterId = await transition(OWNER_TX, TransactionStatus.Completed);
    const after = await tail.waitFor((m) => m.id === afterId);
    expect(after.id).toBe(tailId + 1);
    expect(tail.messages.map((m) => m.id)).toEqual([afterId]);
  });

  it("replays nothing when the client reconnects already caught up", async () => {
    const client = await openStream({ transactionId: OWNER_TX });
    const lastId = await transition(OWNER_TX, TransactionStatus.Processing);
    await client.waitFor((m) => m.id === lastId);
    client.close();
    await waitForStats((stats) => stats.connections === 0);

    const reconnected = await openStream({
      transactionId: OWNER_TX,
      lastEventId: String(lastId),
    });

    const afterId = await transition(OWNER_TX, TransactionStatus.Completed);
    const after = await reconnected.waitFor((m) => m.id === afterId);
    expect(after.id).toBe(lastId + 1);
    expect(reconnected.messages.map((m) => m.id)).toEqual([afterId]);
    expect(reconnected.messages.some((m) => m.event === "stream-gap")).toBe(
      false,
    );
  });
});
