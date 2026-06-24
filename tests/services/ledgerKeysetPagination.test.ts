import {
  LedgerService,
  decodeLedgerEntryCursor,
  encodeLedgerEntryCursor,
} from "../../src/services/ledgerService";

describe("LedgerService keyset pagination", () => {
  it("encodes and decodes stable ledger entry cursors", () => {
    const cursor = encodeLedgerEntryCursor({
      id: "11111111-1111-1111-1111-111111111111",
      entry_date: new Date("2026-04-29T00:00:00.000Z"),
      created_at: new Date("2026-04-29T10:15:30.000Z"),
    });

    expect(decodeLedgerEntryCursor(cursor)).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      entryDate: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T10:15:30.000Z",
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeLedgerEntryCursor("not-a-cursor")).toThrow(
      "Invalid ledger entry cursor",
    );

    const invalidValues = Buffer.from(
      JSON.stringify({
        entryDate: "not-a-date",
        createdAt: "also-not-a-date",
        id: "not-a-uuid",
      }),
      "utf8",
    ).toString("base64url");

    expect(() => decodeLedgerEntryCursor(invalidValues)).toThrow(
      "Invalid ledger entry cursor",
    );
  });

  it("queries one extra row and returns a next cursor when another page exists", async () => {
    const rows = [
      {
        id: "33333333-3333-3333-3333-333333333333",
        entry_date: "2026-04-29",
        account_code: "1100",
        account_name: "Mobile Money Float",
        debit_amount: "3",
        credit_amount: "0",
        description: "third",
        reference_number: "REF-3",
        transaction_id: null,
        created_at: "2026-04-29T10:03:00.000Z",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        entry_date: "2026-04-29",
        account_code: "1100",
        account_name: "Mobile Money Float",
        debit_amount: "2",
        credit_amount: "0",
        description: "second",
        reference_number: "REF-2",
        transaction_id: null,
        created_at: "2026-04-29T10:02:00.000Z",
      },
      {
        id: "11111111-1111-1111-1111-111111111111",
        entry_date: "2026-04-29",
        account_code: "1100",
        account_name: "Mobile Money Float",
        debit_amount: "1",
        credit_amount: "0",
        description: "first",
        reference_number: "REF-1",
        transaction_id: null,
        created_at: "2026-04-29T10:01:00.000Z",
      },
    ];
    const query = jest.fn().mockResolvedValue({ rows });
    const service = new LedgerService({ query } as any);

    const page = await service.getEntriesByAccountPage("1100", { limit: 2 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "(le.entry_date, le.created_at, le.id) < ($4::DATE, $5::TIMESTAMP, $6::UUID)",
      ),
      ["1100", null, null, null, null, null, 3],
    );
    expect(page.entries).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(
      encodeLedgerEntryCursor({
        id: "22222222-2222-2222-2222-222222222222",
        entry_date: "2026-04-29",
        created_at: "2026-04-29T10:02:00.000Z",
      }),
    );
  });

  it("uses decoded cursor values in the keyset predicate", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const service = new LedgerService({ query } as any);
    const cursor = encodeLedgerEntryCursor({
      id: "22222222-2222-2222-2222-222222222222",
      entry_date: "2026-04-29",
      created_at: "2026-04-29T10:02:00.000Z",
    });

    await service.getEntriesByAccountPage("1100", { limit: 25, cursor });

    expect(query.mock.calls[0][1]).toEqual([
      "1100",
      null,
      null,
      "2026-04-29",
      "2026-04-29T10:02:00.000Z",
      "22222222-2222-2222-2222-222222222222",
      26,
    ]);
  });
});
