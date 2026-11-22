import {
  CustomerDataMaskingService,
  customerPseudonym,
} from "../customerDataMaskingService";

type Call = { sql: string; params: unknown[] };

function fakeDb(options: {
  user?: { id: string; anonymized_at: Date | null };
  transactions?: Array<Record<string, unknown>>;
}) {
  const calls: Call[] = [];
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM users WHERE stellar_address")) {
        return { rows: options.user ? [options.user] : [] };
      }
      if (sql.includes("FROM transactions")) {
        return { rows: options.transactions ?? [] };
      }
      if (sql.includes("RETURNING anonymized_at")) {
        return { rows: [{ anonymized_at: new Date("2026-09-24T00:00:00Z") }] };
      }
      return { rows: [] };
    }),
  };
  const db = { connect: jest.fn().mockResolvedValue(client) };
  const find = (fragment: string) =>
    calls.find((c) => c.sql.includes(fragment));
  return { db, client, calls, find };
}

const ACCOUNT = "GCUSTOMERACCOUNT";

describe("customerPseudonym", () => {
  it("is stable, prefixed and fits a VARCHAR(20) phone column", () => {
    const a = customerPseudonym("user-1");
    expect(a).toBe(customerPseudonym("user-1"));
    expect(a).toMatch(/^anon_[0-9a-f]{14}$/);
    expect(a.length).toBeLessThanOrEqual(20);
    expect(customerPseudonym("user-2")).not.toBe(a);
  });
});

describe("CustomerDataMaskingService", () => {
  const txRows = [
    {
      id: "tx-1",
      reference_number: "REF-1",
      stellar_transaction_hash: "hash-1",
      amount: "25.0000000",
      created_at: "2026-01-01 00:00:00",
    },
    {
      id: "tx-2",
      reference_number: "REF-2",
      stellar_transaction_hash: null,
      amount: "5.0000000",
      created_at: "2026-02-01 00:00:00",
    },
  ];

  it("returns null and commits nothing when the customer is unknown", async () => {
    const { db, calls, client } = fakeDb({});

    const result = await new CustomerDataMaskingService(
      db as never,
    ).anonymizeByStellarAccount(ACCOUNT);

    expect(result).toBeNull();
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it("clears every PII column on the user and sets the pseudonym", async () => {
    const { db, find } = fakeDb({
      user: { id: "user-1", anonymized_at: null },
      transactions: txRows,
    });

    await new CustomerDataMaskingService(db as never).anonymizeByStellarAccount(
      ACCOUNT,
    );

    const update = find("UPDATE users")!;
    for (const column of [
      "first_name",
      "last_name",
      "address",
      "date_of_birth",
      "id_number",
      "email",
      "profile_url",
    ]) {
      expect(update.sql).toMatch(new RegExp(`${column}\\s*= NULL`));
    }
    expect(update.sql).toContain("anonymized_at = CURRENT_TIMESTAMP");
    expect(update.params).toEqual(["user-1", customerPseudonym("user-1")]);
  });

  it("clears the KYC applicant payload but keeps the record", async () => {
    const { db, find, calls } = fakeDb({
      user: { id: "user-1", anonymized_at: null },
    });

    await new CustomerDataMaskingService(db as never).anonymizeByStellarAccount(
      ACCOUNT,
    );

    expect(find("UPDATE kyc_applicants")!.sql).toContain(
      "applicant_data = NULL",
    );
    expect(calls.some((c) => /DELETE/i.test(c.sql))).toBe(false);
  });

  it("snapshots transaction hashes into the immutable erasure log first", async () => {
    const { db, calls } = fakeDb({
      user: { id: "user-1", anonymized_at: null },
      transactions: txRows,
    });

    const result = await new CustomerDataMaskingService(
      db as never,
    ).anonymizeByStellarAccount(ACCOUNT);

    const logIndex = calls.findIndex((c) =>
      c.sql.includes("INSERT INTO customer_erasure_log"),
    );
    const userUpdateIndex = calls.findIndex((c) =>
      c.sql.includes("UPDATE users"),
    );
    expect(logIndex).toBeGreaterThan(-1);
    expect(logIndex).toBeLessThan(userUpdateIndex);

    const [userId, pseudonym, snapshot] = calls[logIndex].params as string[];
    expect(userId).toBe("user-1");
    expect(pseudonym).toBe(customerPseudonym("user-1"));
    expect(JSON.parse(snapshot)).toEqual(txRows);
    expect(result).toMatchObject({
      retainedTransactions: 2,
      alreadyAnonymized: false,
    });
  });

  it("only pseudonymizes the phone on transactions, never financial fields", async () => {
    const { db, find } = fakeDb({
      user: { id: "user-1", anonymized_at: null },
      transactions: txRows,
    });

    await new CustomerDataMaskingService(db as never).anonymizeByStellarAccount(
      ACCOUNT,
    );

    const txUpdate = find("UPDATE transactions")!;
    expect(txUpdate.sql).toMatch(/SET phone_number = \$2 WHERE user_id = \$1$/);
    for (const field of ["amount", "reference_number", "metadata", "status"]) {
      expect(txUpdate.sql).not.toContain(field);
    }
  });

  it("wraps the erasure in a single transaction", async () => {
    const { db, calls } = fakeDb({
      user: { id: "user-1", anonymized_at: null },
    });

    await new CustomerDataMaskingService(db as never).anonymizeByStellarAccount(
      ACCOUNT,
    );

    expect(calls[0].sql).toBe("BEGIN");
    expect(calls[1].sql).toContain("FOR UPDATE");
    expect(calls[calls.length - 1].sql).toBe("COMMIT");
  });

  it("is idempotent for an already anonymized customer", async () => {
    const erasedAt = new Date("2026-03-01T00:00:00Z");
    const { db, calls } = fakeDb({
      user: { id: "user-1", anonymized_at: erasedAt },
    });

    const result = await new CustomerDataMaskingService(
      db as never,
    ).anonymizeByStellarAccount(ACCOUNT);

    expect(result).toMatchObject({
      alreadyAnonymized: true,
      anonymizedAt: erasedAt,
    });
    expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "SELECT",
      "COMMIT",
    ]);
  });

  it("rolls back and rethrows when a step fails", async () => {
    const { db, client, calls } = fakeDb({
      user: { id: "user-1", anonymized_at: null },
    });
    const base = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE transactions")) throw new Error("boom");
      return base(sql, params);
    });

    await expect(
      new CustomerDataMaskingService(db as never).anonymizeByStellarAccount(
        ACCOUNT,
      ),
    ).rejects.toThrow("boom");

    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(calls.map((c) => c.sql)).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });
});
