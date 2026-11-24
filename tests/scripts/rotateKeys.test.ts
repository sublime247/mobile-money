import {
  decryptAES,
  deriveKey,
  deserializePayload,
  encryptAES,
  serializePayload,
} from "../../src/utils/encryption";

type Row = Record<string, string | null> & { ctid: string };
type Tables = Record<string, Row[]>;

/**
 * Minimal stateful stand-in for a pg pool client: supports the queries the
 * rotation script issues and real transaction semantics (BEGIN snapshots,
 * ROLLBACK restores, COMMIT keeps changes).
 */
class FakeDatabase {
  tables: Tables = {};
  private snapshot: Tables | null = null;
  committed = false;
  failUpdateOn: string | null = null;

  connect = async () => ({
    query: (text: string, values?: unknown[]) => this.query(text, values),
    release: () => undefined,
  });

  private clone(tables: Tables): Tables {
    return JSON.parse(JSON.stringify(tables));
  }

  async query(text: string, values: unknown[] = []) {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql === "BEGIN") {
      this.snapshot = this.clone(this.tables);
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      if (this.snapshot) this.tables = this.snapshot;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      this.snapshot = null;
      this.committed = true;
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("information_schema.columns")) {
      const rows = Object.entries(this.tables).flatMap(([tableName, tableRows]) =>
        Object.keys(tableRows[0] ?? {})
          .filter((c) => c !== "ctid")
          .map((columnName) => ({ tableName, columnName })),
      );
      return { rows, rowCount: rows.length };
    }

    const select = sql.match(/^SELECT (?:ctid::text AS ctid, )?"(\w+)" AS value FROM "(\w+)"/);
    if (select) {
      const [, column, table] = select;
      const rows = (this.tables[table] ?? [])
        .filter((row) => row[column] !== null)
        .map((row) => ({ ctid: row.ctid, value: row[column] }));
      return { rows, rowCount: rows.length };
    }

    const update = sql.match(/^UPDATE "(\w+)" SET "(\w+)" = \$1 WHERE ctid = \$2::tid/);
    if (update) {
      const [, table, column] = update;
      if (this.failUpdateOn === `${table}.${column}`) {
        throw new Error("simulated write failure");
      }
      const row = (this.tables[table] ?? []).find((r) => r.ctid === values[1]);
      if (row) row[column] = values[0] as string;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

const db = new FakeDatabase();
jest.mock("../../src/config/database", () => ({ pool: db }));

// Imported after the mock so the script picks up the fake pool.
import { rotateKeys } from "../../src/scripts/rotate-keys";

const OLD_KEY = "old-master-key-for-rotation-tests-000000";
const NEW_KEY = "new-master-key-for-rotation-tests-111111";

const encryptWith = (value: string, key: string) =>
  serializePayload(encryptAES(value, deriveKey(key)));
const decryptWith = (value: string, key: string) =>
  decryptAES(deserializePayload(value), deriveKey(key));

const SECRETS = {
  issuer: "SISSUERSECRETSEEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  distribution: "SDISTRIBUTIONSECRETSEEDBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  access: "oauth-access-token",
  refresh: "oauth-refresh-token",
};

function seed(): void {
  db.committed = false;
  db.failUpdateOn = null;
  db.tables = {
    anchored_assets: [
      {
        ctid: "(0,1)",
        issuer_secret_key: encryptWith(SECRETS.issuer, OLD_KEY),
        distribution_secret_key: encryptWith(SECRETS.distribution, OLD_KEY),
      },
    ],
    accounting_connections: [
      {
        ctid: "(0,1)",
        access_token: encryptWith(SECRETS.access, OLD_KEY),
        refresh_token: encryptWith(SECRETS.refresh, OLD_KEY),
      },
      // Versioned payloads (version:iv:tag:ct) are rotated too.
      {
        ctid: "(0,2)",
        access_token: `v1:${encryptWith("second-access", OLD_KEY)}`,
        refresh_token: null,
      },
    ],
    users: [{ ctid: "(0,1)", phone_number: "not-a-target" }],
  };
}

describe("rotate-keys script (end-to-end)", () => {
  beforeEach(() => {
    seed();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("re-encrypts every platform secret with the new key in one committed transaction", async () => {
    const before = JSON.parse(JSON.stringify(db.tables));

    const rotated = await rotateKeys({ oldMasterKey: OLD_KEY, newMasterKey: NEW_KEY });

    expect(rotated).toBe(5);
    expect(db.committed).toBe(true);

    const [asset] = db.tables.anchored_assets;
    const [conn, conn2] = db.tables.accounting_connections;
    expect(decryptWith(asset.issuer_secret_key!, NEW_KEY)).toBe(SECRETS.issuer);
    expect(decryptWith(asset.distribution_secret_key!, NEW_KEY)).toBe(SECRETS.distribution);
    expect(decryptWith(conn.access_token!, NEW_KEY)).toBe(SECRETS.access);
    expect(decryptWith(conn.refresh_token!, NEW_KEY)).toBe(SECRETS.refresh);
    expect(decryptWith(conn2.access_token!, NEW_KEY)).toBe("second-access");
    expect(conn2.refresh_token).toBeNull();

    // The old key no longer opens the rotated values.
    expect(() => decryptWith(asset.issuer_secret_key!, OLD_KEY)).toThrow();
    // Non-target tables are untouched.
    expect(db.tables.users).toEqual(before.users);
  });

  it("dry-run verifies decryption but writes nothing", async () => {
    const before = JSON.parse(JSON.stringify(db.tables));

    const verified = await rotateKeys({
      oldMasterKey: OLD_KEY,
      newMasterKey: NEW_KEY,
      dryRun: true,
    });

    expect(verified).toBe(5);
    expect(db.committed).toBe(false);
    expect(db.tables).toEqual(before);
  });

  it("rolls back everything when any secret cannot be decrypted with the old key", async () => {
    db.tables.accounting_connections[0].refresh_token = encryptWith("x", "some-other-key");
    const before = JSON.parse(JSON.stringify(db.tables));

    await expect(
      rotateKeys({ oldMasterKey: OLD_KEY, newMasterKey: NEW_KEY }),
    ).rejects.toThrow(/decryption failed/i);

    expect(db.committed).toBe(false);
    expect(db.tables).toEqual(before);
  });

  it("rolls back earlier writes when a later write fails mid-rotation", async () => {
    db.failUpdateOn = "accounting_connections.refresh_token";
    const before = JSON.parse(JSON.stringify(db.tables));

    await expect(
      rotateKeys({ oldMasterKey: OLD_KEY, newMasterKey: NEW_KEY }),
    ).rejects.toThrow("simulated write failure");

    expect(db.committed).toBe(false);
    expect(db.tables).toEqual(before);
  });

  it("refuses to rotate to the same key", async () => {
    await expect(
      rotateKeys({ oldMasterKey: OLD_KEY, newMasterKey: OLD_KEY }),
    ).rejects.toThrow(/must be different/);
  });
});
