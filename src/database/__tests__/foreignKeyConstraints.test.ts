/**
 * src/database/__tests__/foreignKeyConstraints.test.ts (#2485)
 *
 * Deterministic tests that do not need a live database:
 *  - the migration hardens the REAL financial FKs to ON DELETE RESTRICT
 *  - it does not invent the stale `balances` / `payouts` / merchants FKs from
 *    the issue text
 *  - MerchantModel.hardDelete() throws a descriptive error instead of issuing
 *    a DELETE, steering callers to the retained soft-delete path
 */

const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
  pool: { query: jest.fn() },
}));

import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES } from "../../constants/errorCodes";
import { MerchantModel } from "../../models/merchant";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");
const UP_PATH = path.join(
  MIGRATIONS_DIR,
  "20261121_harden_merchant_financial_fks.sql",
);
const DOWN_PATH = path.join(
  MIGRATIONS_DIR,
  "20261121_harden_merchant_financial_fks.down.sql",
);

describe("merchant financial FK migration (#2485)", () => {
  const up = fs.readFileSync(UP_PATH, "utf-8");
  const down = fs.readFileSync(DOWN_PATH, "utf-8");

  it("applies ON DELETE RESTRICT to the real transactions FK", () => {
    expect(up).toMatch(
      /ALTER\s+TABLE\s+transactions[\s\S]*?transactions_user_id_fkey[\s\S]*?ON\s+DELETE\s+RESTRICT/i,
    );
  });

  it("applies ON DELETE RESTRICT to the real customer_wallets (balance) FK", () => {
    expect(up).toMatch(
      /ALTER\s+TABLE\s+customer_wallets[\s\S]*?customer_wallets_user_id_fkey[\s\S]*?ON\s+DELETE\s+RESTRICT/i,
    );
  });

  it("does not invent balances, payouts or merchants-referencing FKs", () => {
    // Only the executable DDL counts; the header comment documents the stale
    // issue names deliberately.
    const ddl = up.replace(/--[^\n]*/g, "").toLowerCase();
    expect(ddl).not.toContain("payouts");
    expect(ddl).not.toMatch(/references\s+merchants/);
    expect(ddl).not.toContain("balances");
  });

  it("ships a reversible down migration restoring the prior behaviour", () => {
    expect(down).toContain(
      "DROP CONSTRAINT IF EXISTS transactions_user_id_fkey",
    );
    expect(down).toContain(
      "DROP CONSTRAINT IF EXISTS customer_wallets_user_id_fkey",
    );
    expect(down.toLowerCase()).toContain("on delete cascade");
  });
});

describe("MerchantModel.hardDelete guard (#2485)", () => {
  const model = new MerchantModel();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws a descriptive ConflictError when active financial records exist", async () => {
    mockQueryRead.mockResolvedValue({
      rows: [{ has_financial_records: true }],
    });

    await expect(model.hardDelete("merchant-1")).rejects.toMatchObject({
      name: "ConflictError",
      code: ERROR_CODES.CONFLICT,
      statusCode: 409,
      message: expect.stringContaining(
        "active transactions or wallet balances",
      ),
      details: expect.objectContaining({
        merchantId: "merchant-1",
        hasFinancialRecords: true,
        useInstead: "softDelete",
      }),
    });

    expect(mockQueryRead).toHaveBeenCalledWith(
      expect.stringContaining("SELECT EXISTS"),
      ["merchant-1"],
    );
    expect(mockQueryWrite).not.toHaveBeenCalled();
  });

  it("still refuses a hard delete when no active records exist", async () => {
    mockQueryRead.mockResolvedValue({
      rows: [{ has_financial_records: false }],
    });

    await expect(model.hardDelete("merchant-2")).rejects.toMatchObject({
      name: "ConflictError",
      code: ERROR_CODES.CONFLICT,
    });
    expect(mockQueryWrite).not.toHaveBeenCalled();
  });
});
