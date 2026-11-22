/**
 * src/models/__tests__/softDelete.test.ts (#2376)
 *
 * Unit tests (pool mocked, no real DB) asserting that:
 *  - default reads on UserModel/MerchantModel filter out soft-deleted rows
 *  - `includeDeleted: true` bypasses that filter for compliance/audit reads
 *  - softDelete() sets deleted_at via UPDATE rather than issuing a DELETE
 *
 * These complement (but do not replace) the existing integration-style
 * tests in src/tests/models/user.test.ts, which require a live Postgres
 * instance and are out of scope for an isolated `npx jest` run.
 */

const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

jest.mock("../../utils/encryption", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v ? String(v).replace(/^enc:/, "") : v),
  encryptField: (v: string) => `enc:${v}`,
  decryptField: (v: string) => (v ? String(v).replace(/^enc:/, "") : v),
}));

import { UserModel } from "../users";
import { MerchantModel } from "../merchant";

describe("UserModel soft delete (#2376)", () => {
  const userModel = new UserModel();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("findById excludes soft-deleted rows by default", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });

    const user = await userModel.findById("user-1");

    expect(user).toBeNull();
    expect(mockQueryRead).toHaveBeenCalledWith(
      expect.stringContaining("deleted_at IS NULL"),
      ["user-1"],
    );
  });

  it("findById with includeDeleted bypasses the deleted_at filter", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          phone_number: "enc:+15550001111",
          kyc_level: "basic",
          email: "enc:a@example.com",
          status: "active",
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: new Date("2026-10-01T00:00:00.000Z"),
        },
      ],
    });

    const user = await userModel.findById("user-1", undefined, {
      includeDeleted: true,
    });

    expect(mockQueryRead).toHaveBeenCalledWith(
      expect.not.stringContaining("deleted_at IS NULL"),
      ["user-1"],
    );
    expect(user?.deletedAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });

  it("softDelete issues an UPDATE (not a DELETE) and sets deleted_at", async () => {
    mockQueryWrite.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          phone_number: "enc:+15550001111",
          kyc_level: "basic",
          email: "enc:a@example.com",
          status: "active",
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: new Date(),
        },
      ],
    });

    const result = await userModel.softDelete("user-1");

    expect(mockQueryWrite).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE users"),
      ["user-1"],
    );
    expect(mockQueryWrite).toHaveBeenCalledWith(
      expect.stringContaining("SET deleted_at = CURRENT_TIMESTAMP"),
      ["user-1"],
    );
    const [query] = mockQueryWrite.mock.calls[0];
    expect(query).not.toMatch(/^\s*DELETE/i);
    expect(result?.deletedAt).toBeInstanceOf(Date);
  });

  it("softDelete is idempotent: re-deleting an already-deleted user returns the existing record instead of erroring", async () => {
    mockQueryWrite.mockResolvedValueOnce({ rows: [] }); // WHERE deleted_at IS NULL matched nothing
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          phone_number: "enc:+15550001111",
          kyc_level: "basic",
          email: "enc:a@example.com",
          status: "active",
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await userModel.softDelete("user-1");

    expect(result?.deletedAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });
});

describe("MerchantModel soft delete (#2376)", () => {
  const merchantModel = new MerchantModel();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const merchantRow = {
    id: "merchant-1",
    name: "Test Merchant",
    email: "merchant@example.com",
    phone_number: "+15550002222",
    country: "CM",
    status: "active",
    kyc_status: "verified",
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  it("findById excludes soft-deleted rows by default", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });

    const merchant = await merchantModel.findById("merchant-1");

    expect(merchant).toBeNull();
    expect(mockQueryRead).toHaveBeenCalledWith(
      expect.stringContaining("deleted_at IS NULL"),
      ["merchant-1"],
    );
  });

  it("findById with includeDeleted returns a soft-deleted merchant", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        { ...merchantRow, deleted_at: new Date("2026-10-05T00:00:00.000Z") },
      ],
    });

    const merchant = await merchantModel.findById("merchant-1", {
      includeDeleted: true,
    });

    expect(mockQueryRead).toHaveBeenCalledWith(
      expect.not.stringContaining("deleted_at IS NULL"),
      ["merchant-1"],
    );
    expect(merchant?.deletedAt).toEqual(new Date("2026-10-05T00:00:00.000Z"));
  });

  it("list() filters out soft-deleted merchants by default", async () => {
    mockQueryRead
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [merchantRow] });

    await merchantModel.list();

    const countCall = mockQueryRead.mock.calls[0][0] as string;
    const listCall = mockQueryRead.mock.calls[1][0] as string;
    expect(countCall).toContain("deleted_at IS NULL");
    expect(listCall).toContain("deleted_at IS NULL");
  });

  it("list({ includeDeleted: true }) omits the deleted_at filter", async () => {
    mockQueryRead
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [merchantRow] });

    await merchantModel.list({ includeDeleted: true });

    const countCall = mockQueryRead.mock.calls[0][0] as string;
    expect(countCall).not.toContain("deleted_at IS NULL");
  });

  it("softDelete issues an UPDATE (not a DELETE) and sets deleted_at", async () => {
    mockQueryWrite.mockResolvedValueOnce({
      rows: [{ ...merchantRow, deleted_at: new Date() }],
    });

    const result = await merchantModel.softDelete("merchant-1");

    const [query, params] = mockQueryWrite.mock.calls[0];
    expect(query).toContain("UPDATE merchants");
    expect(query).toContain("SET deleted_at = CURRENT_TIMESTAMP");
    expect(query).not.toMatch(/^\s*DELETE/i);
    expect(params).toEqual(["merchant-1"]);
    expect(result?.deletedAt).toBeInstanceOf(Date);
  });
});
