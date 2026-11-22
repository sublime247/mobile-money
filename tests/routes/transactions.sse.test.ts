// The transaction router pulls in middleware that issues a schema-provisioning
// query at import time (src/middleware/idempotency.ts); mocking the query
// layer keeps this suite hermetic instead of reaching for a live database.
jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  queryWrite: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  querySmart: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  queryTransactionLogRead: jest
    .fn()
    .mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { query: jest.fn(), on: jest.fn() },
}));

import express from "express";
import http from "http";
import { AddressInfo } from "net";
import {
  TransactionModel,
  TransactionStatus,
} from "../../src/models/transaction";
import { transactionRoutes } from "../../src/routes/transactions";
import { generateToken } from "../../src/auth/jwt";
import {
  publishTransactionEvent,
  getTransactionStreamStats,
  resetTransactionEventStream,
  type TransactionStreamStats,
} from "../../src/services/transactionEventStream";

const OWNER_ID = "user-123";
const OTHER_USER_ID = "user-999";

const fakeTransaction = {
  id: "tx-1",
  referenceNumber: "REF-1",
  type: "deposit",
  amount: "10000",
  phoneNumber: "+237600000000",
  provider: "MTN",
  status: TransactionStatus.Pending,
  userId: OWNER_ID,
  createdAt: new Date("2026-05-30T10:00:00Z"),
  updatedAt: new Date("2026-05-30T10:05:00Z"),
};

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

/**
 * Minimal SSE client over raw HTTP. Reads frames incrementally (the stream
 * never ends on its own) and exposes waiters so tests can assert on
 * asynchronous, ordered delivery without arbitrary sleeps.
 */
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
      // Also surfaces pre-response failures (connection refused, etc.)
      req.on("error", (err) => {
        this.rejectWaiters(err.message);
        reject(err);
      });
      req.end();
      this.request = req;
    });
  }

  json(): unknown {
    return JSON.parse(this.raw);
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
    return null; // comment-only frame (e.g. heartbeat), no event dispatched
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

describe("GET /api/transactions/stream (SSE)", () => {
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  let findByIdSpy: jest.SpyInstance;
  const openClients: SseClient[] = [];

  async function openStream(
    options: {
      transactionId?: string;
      lastEventId?: string;
      auth?: boolean;
    } = {},
  ): Promise<SseClient> {
    const path = `/api/transactions/stream${
      options.transactionId
        ? `?transactionId=${encodeURIComponent(options.transactionId)}`
        : ""
    }`;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (options.auth !== false) headers.Authorization = `Bearer ${token}`;
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

  function publishStatus(transactionId: string, status: string) {
    return publishTransactionEvent({
      transactionId,
      userId: OWNER_ID,
      status,
      message: `${transactionId} is now ${status}`,
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret";
    token = generateToken({
      userId: OWNER_ID,
      email: "user@example.com",
      role: "merchant",
    });

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
    findByIdSpy = jest.spyOn(TransactionModel.prototype, "findById");
    findByIdSpy.mockResolvedValue(fakeTransaction);
  });

  afterEach(() => {
    for (const client of openClients.splice(0)) client.close();
    findByIdSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Live delivery
  // -------------------------------------------------------------------------
  describe("live stream", () => {
    it("connects and streams transaction events as they happen", async () => {
      const client = await openStream({ transactionId: fakeTransaction.id });

      expect(client.status).toBe(200);
      expect(String(client.headers["content-type"])).toMatch(
        /text\/event-stream/,
      );
      expect(String(client.headers["cache-control"])).toContain("no-cache");
      expect(client.headers["x-accel-buffering"]).toBe("no");

      const first = publishStatus(fakeTransaction.id, "processing");
      const received = await client.waitFor((m) => m.id === first.id);
      expect(JSON.parse(received.data)).toMatchObject({
        transactionId: fakeTransaction.id,
        userId: OWNER_ID,
        status: "processing",
        id: first.id,
      });

      const second = publishStatus(fakeTransaction.id, "completed");
      expect(second.id).toBe(first.id + 1);
      const next = await client.waitFor((m) => m.id === second.id);
      expect(JSON.parse(next.data).status).toBe("completed");
      expect(client.messages.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it("delivers events to a subscriber without a transaction filter", async () => {
      const client = await openStream();

      const event = publishStatus(fakeTransaction.id, "processing");
      const received = await client.waitFor((m) => m.id === event.id);
      expect(JSON.parse(received.data).transactionId).toBe(fakeTransaction.id);
    });

    it("never delivers events for other transactions or other users", async () => {
      const client = await openStream({ transactionId: fakeTransaction.id });

      publishTransactionEvent({
        transactionId: "tx-other",
        userId: OTHER_USER_ID,
        status: "completed",
      });
      publishTransactionEvent({
        transactionId: "tx-other",
        userId: OWNER_ID,
        status: "completed",
      });
      publishTransactionEvent({
        transactionId: fakeTransaction.id,
        userId: OTHER_USER_ID,
        status: "completed",
      });

      const visible = publishStatus(fakeTransaction.id, "completed");
      await client.waitFor((m) => m.id === visible.id);

      expect(client.messages).toHaveLength(1);
      expect(client.raw).not.toContain("tx-other");
      expect(client.raw).not.toContain(OTHER_USER_ID);
    });

    it("rejects unauthenticated connections", async () => {
      const response = await openStream({ auth: false });
      expect(response.status).toBe(401);
      expect((response.json() as { error: string }).error).toBe(
        "Access denied",
      );
      expect(getTransactionStreamStats().connections).toBe(0);
    });

    it("rejects streams for transactions the user cannot access", async () => {
      findByIdSpy.mockResolvedValueOnce(null);
      const missing = await openStream({ transactionId: "tx-missing" });
      expect(missing.status).toBe(404);

      findByIdSpy.mockResolvedValueOnce({
        ...fakeTransaction,
        userId: OTHER_USER_ID,
      });
      const forbidden = await openStream({ transactionId: fakeTransaction.id });
      expect(forbidden.status).toBe(403);

      expect(getTransactionStreamStats().connections).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Last-Event-ID catch-up replay
  // -------------------------------------------------------------------------
  describe("Last-Event-ID replay", () => {
    it("replays every missed event, in order, after reconnecting", async () => {
      const first = await openStream({ transactionId: fakeTransaction.id });
      const e1 = publishStatus(fakeTransaction.id, "pending");
      const e2 = publishStatus(fakeTransaction.id, "processing");
      const e3 = publishStatus(fakeTransaction.id, "completed");
      await first.waitFor((m) => m.id === e3.id);
      expect(first.messages.map((m) => m.id)).toEqual([e1.id, e2.id, e3.id]);

      // Client drops; these happen while it is away.
      first.close();
      await waitForStats((stats) => stats.connections === 0);

      const e4 = publishStatus(fakeTransaction.id, "processing");
      const e5 = publishStatus(fakeTransaction.id, "completed");
      const e6 = publishStatus(fakeTransaction.id, "failed");

      const second = await openStream({
        transactionId: fakeTransaction.id,
        lastEventId: String(e3.id),
      });

      const replayed = await second.waitForMessages(3);
      expect(replayed.map((m) => m.id)).toEqual([e4.id, e5.id, e6.id]);
      expect(replayed[0].id).toBe(e3.id + 1);
      expect(second.messages.some((m) => m.event === "stream-gap")).toBe(false);

      // Live delivery resumes straight after the replayed backlog.
      const e7 = publishStatus(fakeTransaction.id, "completed");
      const live = await second.waitFor((m) => m.id === e7.id);
      expect(JSON.parse(live.data).status).toBe("completed");
      expect(second.messages.map((m) => m.id)).toEqual([
        e4.id,
        e5.id,
        e6.id,
        e7.id,
      ]);
    });

    it("replays nothing when reconnecting at the newest event id", async () => {
      await openStream({ transactionId: fakeTransaction.id });
      const e1 = publishStatus(fakeTransaction.id, "processing");
      const e2 = publishStatus(fakeTransaction.id, "completed");
      expect(e2.id).toBe(2);

      const client = await openStream({
        transactionId: fakeTransaction.id,
        lastEventId: String(e2.id),
      });
      const e3 = publishStatus(fakeTransaction.id, "completed");

      const delivered = await client.waitFor((m) => m.id === e3.id);
      expect(JSON.parse(delivered.data).status).toBe("completed");
      expect(client.messages.map((m) => m.id)).toEqual([e3.id]);
      expect(client.messages.some((m) => m.event === "stream-gap")).toBe(false);
    });

    it("replays the whole buffer when the id sits just before it", async () => {
      process.env.SSE_REPLAY_BUFFER_SIZE = "5";
      for (let i = 0; i < 10; i++) {
        publishStatus(fakeTransaction.id, "processing");
      }
      expect(getTransactionStreamStats().bufferedEvents).toBe(5);

      // Buffer holds ids 6..10 — id 5 is the last evicted one, so this is a
      // clean resume point with no gap.
      const client = await openStream({
        transactionId: fakeTransaction.id,
        lastEventId: "5",
      });
      const messages = await client.waitForMessages(5);
      expect(messages.map((m) => m.id)).toEqual([6, 7, 8, 9, 10]);
      expect(client.messages.some((m) => m.event === "stream-gap")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Buffer boundary cases
  // -------------------------------------------------------------------------
  describe("replay ring buffer boundaries", () => {
    it("reports a gap and replays what is left after a buffer overflow", async () => {
      process.env.SSE_REPLAY_BUFFER_SIZE = "5";
      for (let i = 0; i < 10; i++) {
        publishStatus(fakeTransaction.id, "processing");
      }
      expect(getTransactionStreamStats().bufferedEvents).toBe(5);

      // Ids 1..5 were evicted while the client was away; 6..10 survive.
      const client = await openStream({
        transactionId: fakeTransaction.id,
        lastEventId: "3",
      });

      const messages = await client.waitForMessages(6);
      expect(messages[0].event).toBe("stream-gap");
      expect(JSON.parse(messages[0].data)).toEqual({
        requestedId: 3,
        oldestRetainedId: 6,
      });
      expect(messages.slice(1).map((m) => m.id)).toEqual([6, 7, 8, 9, 10]);

      // The stream is usable afterwards: live events keep flowing.
      const e11 = publishStatus(fakeTransaction.id, "completed");
      const live = await client.waitFor((m) => m.id === e11.id);
      expect(JSON.parse(live.data).status).toBe("completed");
      expect(client.raw).not.toContain(`id: 1\n`);
      expect(client.raw).not.toContain(`id: 5\n`);
    });

    it("keeps the buffer bounded regardless of how many events are published", async () => {
      process.env.SSE_REPLAY_BUFFER_SIZE = "3";
      for (let i = 0; i < 50; i++) {
        publishStatus(fakeTransaction.id, "processing");
      }
      const stats = getTransactionStreamStats();
      expect(stats.bufferedEvents).toBe(3);
      expect(stats.nextEventId).toBe(51);

      const client = await openStream({
        transactionId: fakeTransaction.id,
        lastEventId: "1",
      });
      const messages = await client.waitForMessages(4);
      expect(messages[0].event).toBe("stream-gap");
      expect(messages.slice(1).map((m) => m.id)).toEqual([48, 49, 50]);
    });

    it("ignores invalid Last-Event-ID values and streams live events", async () => {
      const invalidIds = ["not-a-number", "-5", "1.5", "9e3", ""];
      publishStatus(fakeTransaction.id, "processing");

      for (const lastEventId of invalidIds) {
        const client = await openStream({
          transactionId: fakeTransaction.id,
          lastEventId,
        });

        const event = publishStatus(fakeTransaction.id, "processing");
        const received = await client.waitFor((m) => m.id === event.id);

        // Nothing was replayed: the first event seen is the live one.
        expect(client.messages[0].id).toBe(event.id);
        expect(received.id).toBe(event.id);
        expect(client.messages.some((m) => m.event === "stream-gap")).toBe(
          false,
        );
        if (lastEventId !== "") {
          expect(client.raw).toContain(
            `invalid last-event-id "${lastEventId}"`,
          );
        }
      }
    });

    it("treats an id beyond the newest event as a live-only resume", async () => {
      publishStatus(fakeTransaction.id, "processing");

      const client = await openStream({
        transactionId: fakeTransaction.id,
        lastEventId: "999999",
      });
      const event = publishStatus(fakeTransaction.id, "completed");
      await client.waitFor((m) => m.id === event.id);

      expect(client.messages).toHaveLength(1);
      expect(client.messages[0].event).not.toBe("stream-gap");
    });
  });

  // -------------------------------------------------------------------------
  // Disconnect cleanup
  // -------------------------------------------------------------------------
  describe("disconnect cleanup", () => {
    it("releases listeners, connections and heartbeats on disconnect", async () => {
      expect(getTransactionStreamStats()).toEqual({
        connections: 0,
        listeners: 0,
        heartbeats: 0,
        bufferedEvents: 0,
        nextEventId: 1,
      });

      const client = await openStream({ transactionId: fakeTransaction.id });
      expect(getTransactionStreamStats()).toMatchObject({
        connections: 1,
        listeners: 1,
        heartbeats: 1,
      });

      const event = publishStatus(fakeTransaction.id, "processing");
      await client.waitFor((m) => m.id === event.id);

      client.close();
      const afterClose = await waitForStats((stats) => stats.connections === 0);
      expect(afterClose).toMatchObject({
        connections: 0,
        listeners: 0,
        heartbeats: 0,
      });

      // Publishing after disconnect must not reach a dead response.
      expect(() =>
        publishStatus(fakeTransaction.id, "completed"),
      ).not.toThrow();
      expect(getTransactionStreamStats().listeners).toBe(0);
    });

    it("does not leak listeners across repeated connect/disconnect cycles", async () => {
      for (let cycle = 0; cycle < 10; cycle++) {
        const client = await openStream({
          transactionId: fakeTransaction.id,
        });

        const event = publishStatus(fakeTransaction.id, "processing");
        await client.waitFor((m) => m.id === event.id);

        expect(getTransactionStreamStats()).toMatchObject({
          connections: 1,
          listeners: 1,
          heartbeats: 1,
        });

        client.close();
        await waitForStats((stats) => stats.connections === 0);
      }

      const stats = getTransactionStreamStats();
      expect(stats).toMatchObject({
        connections: 0,
        listeners: 0,
        heartbeats: 0,
      });
      // Nothing retained on the emitter between cycles either.
      expect(stats.listeners).toBe(stats.connections);
      expect(stats.heartbeats).toBe(stats.connections);
    });
  });
});
