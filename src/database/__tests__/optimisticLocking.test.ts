import { LedgerService, ConcurrentModificationError, InsufficientFundsError, WalletNotFoundError, WALLET_UPDATE_MAX_RETRIES } from "../../services/ledgerService";
import { Pool } from "pg";

function makePool() {
  const query = jest.fn();
  return { pool: { query } as unknown as Pool, query };
}

describe("customer_wallets optimistic locking (#2478)", () => {
  it("increments version and updates balance on successful debit", async () => {
    const { pool, query } = makePool();
    query
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "100.0000000", version: 2, sufficient: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "90.0000000", version: 3 }], rowCount: 1 });
    const service = new LedgerService(pool);

    const wallet = await service.debitWallet("u1", "USD", "10");

    expect(wallet.version).toBe(3);
    expect(query.mock.calls[1][0]).toMatch(/version\s*=\s*version \+ 1/);
    expect(query.mock.calls[1][0]).toContain("WHERE id = $1 AND version = $4");
  });

  it("retries on version mismatch and succeeds with fresh read", async () => {
    const { pool, query } = makePool();
    query
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "100.0000000", version: 1, sufficient: true }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // stale version
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "95.0000000", version: 2, sufficient: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "85.0000000", version: 3 }], rowCount: 1 });
    const service = new LedgerService(pool);

    const wallet = await service.debitWallet("u1", "USD", "10");

    expect(wallet.version).toBe(3);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("throws ConcurrentModificationError after exhausting retries", async () => {
    const { pool, query } = makePool();
    for (let i = 0; i < WALLET_UPDATE_MAX_RETRIES + 1; i++) {
      query
        .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "100.0000000", version: i, sufficient: true }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    }
    const service = new LedgerService(pool);

    await expect(service.debitWallet("u1", "USD", "10")).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it("throws InsufficientFundsError without updating on stale balance", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "5.0000000", version: 7, sufficient: false }] });
    const service = new LedgerService(pool);

    await expect(service.debitWallet("u1", "USD", "10")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("throws WalletNotFoundError for missing wallet", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce({ rows: [] });
    const service = new LedgerService(pool);

    await expect(service.creditWallet("missing", "USD", "10")).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
