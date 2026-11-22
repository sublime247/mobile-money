/**
 * Regression tests for #2378 (read-replica routing).
 *
 * VaultModel.getUserBalanceSummary() must never be served by a read-replica
 * pool: a lagging replica could show a user a stale balance right after a
 * deposit or withdrawal, violating read-your-own-writes consistency. It must
 * always use queryWrite() (primary-only), even though the queries are SELECTs.
 */
const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
  pool: {
    connect: jest.fn(),
    query: jest.fn(),
  },
}));

import { VaultModel } from "../vault";

describe("VaultModel.getUserBalanceSummary — balance reads stay on primary (#2378)", () => {
  let vaultModel: VaultModel;

  beforeEach(() => {
    jest.clearAllMocks();
    vaultModel = new VaultModel();
    mockQueryWrite.mockImplementation((text: string) => {
      if (text.includes("FROM vaults")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [{ balance: "0" }] });
    });
  });

  it("routes the main-balance query through queryWrite (primary), never queryRead (replica)", async () => {
    await vaultModel.getUserBalanceSummary("user-1");

    expect(mockQueryWrite).toHaveBeenCalled();
    const mainBalanceCall = mockQueryWrite.mock.calls.find(([text]) =>
      String(text).includes("FROM transactions"),
    );
    expect(mainBalanceCall).toBeDefined();
    expect(mockQueryRead).not.toHaveBeenCalled();
  });

  it("routes the vault-balances query through queryWrite (primary), never queryRead (replica)", async () => {
    await vaultModel.getUserBalanceSummary("user-1");

    const vaultBalancesCall = mockQueryWrite.mock.calls.find(([text]) =>
      String(text).includes("FROM vaults"),
    );
    expect(vaultBalancesCall).toBeDefined();
    expect(mockQueryRead).not.toHaveBeenCalled();
  });

  it("passes the userId parameter through to both primary queries", async () => {
    await vaultModel.getUserBalanceSummary("user-42");

    for (const [, params] of mockQueryWrite.mock.calls) {
      expect(params).toEqual(["user-42"]);
    }
  });

  it("still sums main balance and vault balances into a total", async () => {
    mockQueryWrite.mockImplementation((text: string) => {
      if (text.includes("FROM vaults")) {
        return Promise.resolve({
          rows: [{ id: "v1", name: "Emergency Fund", balance: "25.00" }],
        });
      }
      return Promise.resolve({ rows: [{ balance: "100.00" }] });
    });

    const summary = await vaultModel.getUserBalanceSummary("user-1");

    expect(summary.mainBalance).toBe("100.00");
    expect(summary.vaultBalances).toEqual([
      { vaultId: "v1", vaultName: "Emergency Fund", balance: "25.00" },
    ]);
    expect(summary.totalBalance).toBe("125");
  });
});
