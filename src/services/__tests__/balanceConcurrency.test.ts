/** @jest-environment node */
import { jest } from "@jest/globals";

describe("balance concurrency optimistic locking (#2478)", () => {
  it("retries on stale wallet version and prevents lost update", async () => {
    jest.resetModules();
    const query = jest.fn();
    jest.unstable_mockModule("../../config/database", () => ({ pool: { query } }));
    jest.unstable_mockModule("../../utils/logger", () => ({
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    const { LedgerService, ConcurrentModificationError } = await import("../ledgerService");
    const svc = new LedgerService({ query } as any);

    query
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "100.0000000", version: 1, sufficient: true }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "95.0000000", version: 2, sufficient: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "85.0000000", version: 3 }], rowCount: 1 });

    const result = await svc.debitWallet("u1", "USD", "10");
    expect(result.version).toBe(3);
    expect(String(query.mock.calls[1][0])).toMatch(/version\s*=\s*version \+ 1/);
  });

  it("surfaces optimistic lock conflict after retries", async () => {
    jest.resetModules();
    const query = jest.fn();
    jest.unstable_mockModule("../../config/database", () => ({ pool: { query } }));
    jest.unstable_mockModule("../../utils/logger", () => ({
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    const { LedgerService, ConcurrentModificationError, WALLET_UPDATE_MAX_RETRIES } = await import("../ledgerService");
    const svc = new LedgerService({ query } as any);
    for (let i = 0; i < WALLET_UPDATE_MAX_RETRIES + 1; i++) {
      query
        .mockResolvedValueOnce({ rows: [{ id: "w1", user_id: "u1", currency: "USD", balance: "100.0000000", version: i, sufficient: true }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    }
    await expect(svc.debitWallet("u1", "USD", "10")).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});
