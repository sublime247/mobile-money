import { LedgerService } from "../ledgerService";
import { Pool } from "pg";

function makePool(rows: unknown[] = []): { pool: Pool; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query, connect: jest.fn() } as unknown as Pool, query };
}

describe("LedgerService date parameters passed to SQL DATE-typed functions", () => {
  it("getTrialBalance sends a plain YYYY-MM-DD string, not a Date object", async () => {
    const { pool, query } = makePool();
    const service = new LedgerService(pool);

    // A date near midnight UTC — the case most likely to shift by a day
    // if serialized using the process's local timezone instead of UTC.
    const asOfDate = new Date("2026-04-01T00:00:00.000Z");
    await service.getTrialBalance(asOfDate);

    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM get_trial_balance($1)",
      ["2026-04-01"],
    );
    const [, params] = query.mock.calls[0];
    expect(typeof params[0]).toBe("string");
  });

  it("getTrialBalance defaults to today's UTC date when no date is given", async () => {
    const { pool, query } = makePool();
    const service = new LedgerService(pool);

    await service.getTrialBalance();

    const [, params] = query.mock.calls[0];
    expect(params[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("getAccountBalance sends a plain YYYY-MM-DD string, not a Date object", async () => {
    const { pool, query } = makePool([{ balance: "100.00" }]);
    const service = new LedgerService(pool);

    const asOfDate = new Date("2026-04-01T00:00:00.000Z");
    await service.getAccountBalance("1100", asOfDate);

    expect(query).toHaveBeenCalledWith(
      "SELECT get_account_balance($1, $2) as balance",
      ["1100", "2026-04-01"],
    );
  });
});
