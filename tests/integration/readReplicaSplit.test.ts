/**
 * Integration tests for read/write splitting across primary and replica
 * pools (#2290).
 *
 * Loads the real src/config/database.ts with READ_REPLICA_URL set and `pg`
 * replaced by recording fakes, then drives requests through Express with the
 * real readReplicaRoutingMiddleware so routing is decided exactly as in
 * production: by HTTP method (via AsyncLocalStorage) plus SQL inspection.
 */
import express from "express";
import request from "supertest";

jest.mock("../../src/services/auditlogService", () => ({
  auditService: { logPIIAccess: jest.fn().mockResolvedValue(undefined) },
}));

type Call = { pool: string; text: string };

const PRIMARY_URL = "postgresql://app:primary-secret@primary:5432/app";
const REPLICA_URL = "postgresql://ro:replica-secret@replica:5432/app";

/** Recording stand-in for pg.Pool. Behaviour is switchable per test. */
class FakePool {
  static instances: FakePool[] = [];
  static calls: Call[] = [];

  name: string;
  connectError: Error | null = null;
  queryError: Error | null = null;
  lagSeconds = 0;
  released: Array<boolean | Error | undefined> = [];
  listeners: Record<string, (err: Error) => void> = {};
  totalCount = 2;
  idleCount = 1;
  waitingCount = 0;

  constructor(opts: { connectionString: string }) {
    this.name = opts.connectionString === REPLICA_URL ? "replica" : "primary";
    FakePool.instances.push(this);
  }

  private run(text: string) {
    if (/pg_is_in_recovery/.test(text)) {
      return { rows: [{ lag_seconds: this.lagSeconds }], rowCount: 1 };
    }
    FakePool.calls.push({ pool: this.name, text });
    if (this.queryError) throw this.queryError;
    return { rows: [{ served_by: this.name }], rowCount: 1 };
  }

  async query(config: any) {
    return this.run(typeof config === "string" ? config : config.text);
  }

  async connect() {
    if (this.connectError) throw this.connectError;
    return {
      query: async (config: any) =>
        this.run(typeof config === "string" ? config : config.text),
      release: (arg?: boolean | Error) => {
        this.released.push(arg);
      },
    };
  }

  on(event: string, listener: (err: Error) => void) {
    this.listeners[event] = listener;
    return this;
  }

  async end() {}
}

jest.mock("pg", () => ({ Pool: FakePool }));

function connError(code = "ECONNREFUSED") {
  return Object.assign(new Error(`connect ${code}`), { code });
}

function load(env: Record<string, string> = {}) {
  FakePool.instances = [];
  FakePool.calls = [];
  Object.assign(process.env, {
    DATABASE_URL: PRIMARY_URL,
    READ_REPLICA_URL: REPLICA_URL,
    ...env,
  });

  let db!: typeof import("../../src/config/database");
  let mw!: typeof import("../../src/middleware/readReplicaRouting");
  jest.isolateModules(() => {
    db = require("../../src/config/database");
    mw = require("../../src/middleware/readReplicaRouting");
  });

  const replica = FakePool.instances.find((p) => p.name === "replica")!;
  const primary = FakePool.instances.find((p) => p.name === "primary")!;

  const app = express();
  app.use(express.json());
  app.use(mw.readReplicaRoutingMiddleware);

  // Transaction-status polling: a plain read.
  app.get("/transactions/:id/status", async (_req, res) => {
    const r = await db.pool.query("SELECT status FROM transactions WHERE id = $1", ["t1"]);
    res.json(r.rows[0]);
  });
  // A GET handler that also writes (e.g. touching last_seen).
  app.get("/transactions/:id/touch", async (_req, res) => {
    const r = await db.pool.query("UPDATE transactions SET viewed_at = now() WHERE id = $1", ["t1"]);
    res.json(r.rows[0]);
  });
  // A GET handler that needs a fresh read, opting out explicitly.
  app.get("/transactions/:id/fresh", async (_req, res) => {
    const r = await db.queryWrite("SELECT status FROM transactions WHERE id = $1", ["t1"]);
    res.json(r.rows[0]);
  });
  // A GET handler using an explicit transaction on a checked-out client.
  app.get("/transactions/:id/locked", async (_req, res) => {
    const client = await db.pool.connect();
    const r = await client.query("SELECT status FROM transactions WHERE id = $1 FOR UPDATE");
    client.release();
    res.json(r.rows[0]);
  });
  app.post("/transactions", async (_req, res) => {
    await db.pool.query("INSERT INTO transactions (id) VALUES ($1)", ["t2"]);
    const r = await db.pool.query("SELECT status FROM transactions WHERE id = $1", ["t2"]);
    res.json(r.rows[0]);
  });
  app.get("/ctx/write", async (req, res) => {
    const r = await db.queryWithContext(req, "DELETE FROM sessions WHERE expired");
    res.json(r.rows[0]);
  });
  app.post("/ctx/read", async (req, res) => {
    const r = await db.queryWithContext(req, "SELECT 1");
    res.json(r.rows[0]);
  });

  return { db, app, primary, replica };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Read/write split (#2290)", () => {
  it("serves read-only queries from GET requests on the replica", async () => {
    const { app } = load();
    const res = await request(app).get("/transactions/t1/status");
    expect(res.body).toEqual({ served_by: "replica" });
    expect(FakePool.calls).toEqual([
      { pool: "replica", text: expect.stringMatching(/^SELECT status/) },
    ]);
  });

  it("keeps mutations on the primary, even inside GET handlers", async () => {
    const { app } = load();
    expect((await request(app).get("/transactions/t1/touch")).body).toEqual({
      served_by: "primary",
    });
    expect((await request(app).get("/ctx/write")).body).toEqual({
      served_by: "primary",
    });
  });

  it("keeps every query of a write request on the primary (read-your-writes)", async () => {
    const { app } = load();
    await request(app).post("/transactions");
    expect(FakePool.calls.map((c) => c.pool)).toEqual(["primary", "primary"]);
    expect((await request(app).post("/ctx/read")).body).toEqual({ served_by: "primary" });
  });

  it("never routes checked-out clients or explicit queryWrite reads", async () => {
    const { app } = load();
    expect((await request(app).get("/transactions/t1/locked")).body).toEqual({
      served_by: "primary",
    });
    expect((await request(app).get("/transactions/t1/fresh")).body).toEqual({
      served_by: "primary",
    });
  });

  it("uses the primary for queries outside any HTTP request", async () => {
    const { db } = load();
    const r = await db.pool.query("SELECT 1");
    expect(r.rows[0]).toEqual({ served_by: "primary" });
  });

  it("can be switched off with DB_REPLICA_ROUTE_GET=false", async () => {
    const { app } = load({ DB_REPLICA_ROUTE_GET: "false" });
    expect((await request(app).get("/transactions/t1/status")).body).toEqual({
      served_by: "primary",
    });
  });

  describe("fallback", () => {
    it("falls back to primary when the replica is unreachable, and evicts it", async () => {
      const { app, db, replica } = load();
      replica.connectError = connError();

      const first = await request(app).get("/transactions/t1/status");
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ served_by: "primary" });

      // Evicted: the next read goes straight to primary without trying it.
      const connectSpy = jest.spyOn(replica, "connect");
      await request(app).get("/transactions/t1/status");
      expect(connectSpy).not.toHaveBeenCalled();
      expect(db.getReplicaPoolStatus()[0]).toMatchObject({ healthy: false, enabled: false });
    });

    it("destroys the client when the connection drops mid-query", async () => {
      const { app, replica } = load();
      const lost = connError("ECONNRESET");
      replica.queryError = lost;

      const res = await request(app).get("/transactions/t1/status");
      expect(res.body).toEqual({ served_by: "primary" });
      expect(replica.released).toEqual([lost]);
    });

    it("falls back without evicting on a statement error (e.g. read-only violation)", async () => {
      const { app, db, replica } = load();
      replica.queryError = Object.assign(
        new Error("cannot execute nextval() in a read-only transaction"),
        { code: "25006" },
      );

      const res = await request(app).get("/transactions/t1/status");
      expect(res.body).toEqual({ served_by: "primary" });
      expect(replica.released).toEqual([undefined]); // returned to pool, healthy
      expect(db.getReplicaPoolStatus()[0].enabled).toBe(true);
    });

    it("queryRead falls back to primary too", async () => {
      const { db, replica } = load();
      replica.connectError = connError();
      const r = await db.queryRead("SELECT 1");
      expect(r.rows[0]).toEqual({ served_by: "primary" });
    });

    it("survives an idle replica client error and takes the replica out of rotation", async () => {
      const { db, replica } = load();
      expect(() => replica.listeners.error(connError("ECONNRESET"))).not.toThrow();
      expect(db.getReplicaPoolStatus()[0].enabled).toBe(false);
    });
  });

  describe("health monitoring", () => {
    it("re-enables an evicted replica once a health check succeeds", async () => {
      const { app, db, replica } = load();
      replica.connectError = connError();
      await request(app).get("/transactions/t1/status");
      expect(db.getReplicaPoolStatus()[0].enabled).toBe(false);

      replica.connectError = null;
      const health = await db.checkReplicaHealth();
      expect(health[0]).toMatchObject({ healthy: true, enabled: true, lagSeconds: 0 });

      FakePool.calls = [];
      await request(app).get("/transactions/t1/status");
      expect(FakePool.calls[0].pool).toBe("replica");
    });

    it("stops routing to a replica that lags beyond the threshold", async () => {
      const { app, db, replica } = load({ REPLICA_SYNC_LAG_THRESHOLD_SECONDS: "5" });
      replica.lagSeconds = 30;

      const [status] = await db.checkReplicaHealth();
      expect(status).toMatchObject({ healthy: true, enabled: false, lagSeconds: 30 });
      expect((await request(app).get("/transactions/t1/status")).body).toEqual({
        served_by: "primary",
      });
    });

    it("reports pool counters and never exposes the replica password", async () => {
      const { db } = load();
      const [status] = await db.checkReplicaHealth();
      expect(status).toMatchObject({
        totalConnections: 2,
        idleConnections: 1,
        waitingClients: 0,
      });
      expect(status.url).not.toContain("replica-secret");
      expect(status.url).toContain("replica:5432");
    });
  });
});
