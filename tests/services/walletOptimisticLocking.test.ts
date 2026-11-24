/**
 * Concurrency tests for optimistic locking on customer_wallets (#2291).
 *
 * Part 1 runs everywhere: an in-memory stand-in for the two wallet SQL
 * statements (row-level semantics, NUMERIC as scaled integers) that can force
 * concurrent callers to all read the same version before anyone writes, which
 * is exactly the race that causes double spends.
 *
 * Part 2 runs the same scenarios against real PostgreSQL when
 * LEDGER_TEST_DATABASE_URL is set (an isolated schema is created and dropped).
 */
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import {
  ConcurrentModificationError,
  InsufficientFundsError,
  LedgerService,
  WALLET_UPDATE_MAX_RETRIES,
  WalletNotFoundError,
} from "../../src/services/ledgerService";

jest.mock("../../src/config/database", () => ({ pool: {} }));

// ---------------------------------------------------------------------------
// In-memory wallet table
// ---------------------------------------------------------------------------

const SCALE = 10_000_000n; // DECIMAL(20, 7)
const toUnits = (d: string) => {
  const [i, f = ""] = d.split(".");
  return BigInt(i) * SCALE + BigInt((f + "0000000").slice(0, 7));
};
const fromUnits = (u: bigint) => {
  const i = u / SCALE;
  const f = (u % SCALE).toString().padStart(7, "0");
  return `${i}.${f}`;
};

class FakeWalletDb {
  row = {
    id: "w1",
    user_id: "u1",
    currency: "XAF",
    balance: toUnits("100"),
    version: 0,
  };
  updates = 0;
  /** Concurrent readers to hold until all have read (first attempt only). */
  private barrier: { size: number; waiting: Array<() => void> } | null = null;
  /** Simulate a foreign writer committing between every read and write. */
  alwaysConflict = false;
  sql: string[] = [];

  holdFirstReads(size: number) {
    this.barrier = { size, waiting: [] };
  }

  private snapshot() {
    return {
      id: this.row.id,
      user_id: this.row.user_id,
      currency: this.row.currency,
      balance: fromUnits(this.row.balance),
      version: this.row.version,
    };
  }

  async query(text: string, params: any[]) {
    this.sql.push(text);
    if (/^\s*SELECT/.test(text)) {
      const [userId, currency, amount, sign] = params;
      const matches = userId === this.row.user_id && currency === this.row.currency;
      const result = matches
        ? {
            ...this.snapshot(),
            ...(amount !== undefined && {
              sufficient: this.row.balance + BigInt(sign) * toUnits(amount) >= 0n,
            }),
          }
        : null;

      if (this.barrier) {
        const b = this.barrier;
        await new Promise<void>((resolve) => {
          b.waiting.push(resolve);
          if (b.waiting.length === b.size) {
            this.barrier = null;
            b.waiting.forEach((r) => r());
          }
        });
      }
      if (this.alwaysConflict) this.row.version += 1;
      return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
    }

    if (/^\s*UPDATE customer_wallets/.test(text)) {
      this.updates += 1;
      const [id, amount, sign, expectedVersion] = params;
      if (id !== this.row.id || this.row.version !== expectedVersion) {
        return { rows: [], rowCount: 0 };
      }
      const next = this.row.balance + BigInt(sign) * toUnits(amount);
      if (next < 0n) throw new Error("violates check constraint (balance >= 0)");
      this.row.balance = next;
      this.row.version += 1;
      return { rows: [this.snapshot()], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${text}`);
  }
}

function service(db: FakeWalletDb) {
  return new LedgerService(db as unknown as Pool);
}

describe("Wallet optimistic locking (#2291)", () => {
  it("prevents a double spend when two withdrawals read the same balance", async () => {
    const db = new FakeWalletDb();
    const ledger = service(db);
    db.holdFirstReads(2); // both read balance 100 @ v0 before either writes

    const results = await Promise.allSettled([
      ledger.debitWallet("u1", "XAF", "80"),
      ledger.debitWallet("u1", "XAF", "80"),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(InsufficientFundsError);
    expect(fromUnits(db.row.balance)).toBe("20.0000000");
    expect(db.row.version).toBe(1);
  });

  it("applies every deduction exactly once under contention (no lost updates)", async () => {
    const db = new FakeWalletDb();
    const ledger = service(db);
    db.holdFirstReads(3);

    const wallets = await Promise.all([
      ledger.debitWallet("u1", "XAF", "10"),
      ledger.debitWallet("u1", "XAF", "10.5"),
      ledger.debitWallet("u1", "XAF", "0.0000001"),
    ]);

    expect(fromUnits(db.row.balance)).toBe("79.4999999");
    expect(db.row.version).toBe(3);
    expect(wallets.map((w) => w.version).sort()).toEqual([1, 2, 3]);
    // At least two writers lost the first race and had to retry.
    expect(db.updates).toBeGreaterThanOrEqual(5);
  });

  it(`gives up with ConcurrentModificationError after ${WALLET_UPDATE_MAX_RETRIES} retries`, async () => {
    const db = new FakeWalletDb();
    db.alwaysConflict = true;

    const err = await service(db)
      .debitWallet("u1", "XAF", "1")
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConcurrentModificationError);
    expect(err.attempts).toBe(WALLET_UPDATE_MAX_RETRIES + 1);
    expect(db.updates).toBe(WALLET_UPDATE_MAX_RETRIES + 1);
    expect(fromUnits(db.row.balance)).toBe("100.0000000"); // nothing written
  });

  it("increments version and guards the update on the version that was read", async () => {
    const db = new FakeWalletDb();
    const wallet = await service(db).creditWallet("u1", "XAF", "5.25");

    expect(wallet).toMatchObject({ balance: "105.2500000", version: 1 });
    const update = db.sql.find((q) => /UPDATE/.test(q))!;
    expect(update).toMatch(/version\s*=\s*version \+ 1/);
    expect(update).toMatch(/WHERE id = \$1 AND version = \$4/);
  });

  it("rejects overdrafts without writing", async () => {
    const db = new FakeWalletDb();
    await expect(service(db).debitWallet("u1", "XAF", "100.0000001")).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(db.updates).toBe(0);
  });

  it("throws WalletNotFoundError for a missing wallet", async () => {
    const db = new FakeWalletDb();
    await expect(service(db).debitWallet("u1", "USD", "1")).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  it.each(["0", "-5", "abc", "1.00000001", 0.1 + 0.2, ""])(
    "rejects invalid amount %p",
    async (amount) => {
      const db = new FakeWalletDb();
      await expect(service(db).debitWallet("u1", "XAF", amount as any)).rejects.toThrow(
        /Invalid wallet amount/,
      );
      expect(db.sql).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Real PostgreSQL (opt-in)
// ---------------------------------------------------------------------------

const PG_URL = process.env.LEDGER_TEST_DATABASE_URL;
const describePg = PG_URL ? describe : describe.skip;

describePg("Wallet optimistic locking against PostgreSQL (#2291)", () => {
  const schema = `wallet_lock_test_${Date.now()}`;
  let pool: Pool;
  let ledger: LedgerService;
  const userId = "00000000-0000-4000-8000-000000000001";

  const migration = (name: string) =>
    fs.readFileSync(path.resolve(__dirname, "../../migrations", name), "utf8");

  beforeAll(async () => {
    pool = new Pool({
      connectionString: PG_URL,
      max: 25,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE users (id UUID PRIMARY KEY)`);
    await pool.query(migration("20261020_create_customer_wallets.sql"));
    await pool.query(migration("20261021_add_version_to_customer_wallets.sql"));
    await pool.query(`INSERT INTO users (id) VALUES ($1)`, [userId]);
    ledger = new LedgerService(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM customer_wallets`);
    await pool.query(
      `INSERT INTO customer_wallets (user_id, currency, balance) VALUES ($1, 'XAF', 100)`,
      [userId],
    );
  });

  it("new wallets start at version 0", async () => {
    expect(await ledger.getWallet(userId, "XAF")).toMatchObject({
      balance: "100.0000000",
      version: 0,
    });
  });

  it("never overdraws or loses an update under 20 simultaneous withdrawals", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => ledger.debitWallet(userId, "XAF", "10")),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    const wallet = (await ledger.getWallet(userId, "XAF"))!;

    // Conservation: exactly the successful deductions were applied, once each.
    expect(Number(wallet.balance)).toBe(100 - succeeded * 10);
    expect(wallet.version).toBe(succeeded);
    expect(succeeded).toBeLessThanOrEqual(10);
    for (const reason of reasons) {
      expect(
        reason instanceof InsufficientFundsError ||
          reason instanceof ConcurrentModificationError,
      ).toBe(true);
    }
  });

  it("serves sequential withdrawals until the balance is exhausted", async () => {
    for (let i = 0; i < 10; i++) await ledger.debitWallet(userId, "XAF", "10");
    await expect(ledger.debitWallet(userId, "XAF", "0.0000001")).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(await ledger.getWallet(userId, "XAF")).toMatchObject({
      balance: "0.0000000",
      version: 10,
    });
  });
});
