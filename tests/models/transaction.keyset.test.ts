const mockQueryRead = jest.fn();
const mockPoolQuery = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: {
    query: mockPoolQuery,
  },
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: mockQueryWrite,
}));

jest.mock("../../src/utils/encryption", () => ({
  encrypt: (value: unknown) => value,
  decrypt: (value: unknown) => value,
}));

jest.mock("../../src/utils/lock", () => ({
  lockManager: {
    withLock: jest.fn(async (_resource: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  },
  LockKeys: {
    referenceNumber: (date: string) => `reference:${date}`,
  },
}));

jest.mock("../../src/services/cachedTransactionService", () => ({
  CachedTransactionInvalidation: {
    invalidateUserCaches: jest.fn(async () => undefined),
    invalidateProviderStats: jest.fn(async () => undefined),
    invalidateGeneralStats: jest.fn(async () => undefined),
  },
}));

jest.mock("../../src/graphql/redisPubSub", () => ({
  getRedisPubSub: jest.fn(() => ({ publish: jest.fn() })),
}));

jest.mock("../../src/websocket", () => ({
  WebSocketManager: {
    getInstance: jest.fn(() => ({ broadcastTransactionUpdate: jest.fn() })),
  },
}));

import { queryWrite } from "../../src/config/database";
import { CachedTransactionInvalidation } from "../../src/services/cachedTransactionService";
import { TransactionModel, TransactionStatus } from "../../src/models/transaction";

const row = (id: string, createdAt: string) => ({
  id,
  referenceNumber: `TX-${id}`,
  type: "deposit",
  amount: "100",
  phoneNumber: "+237600000000",
  provider: "mtn",
  stellarAddress: "G".padEnd(56, "A"),
  status: TransactionStatus.Completed,
  tags: [],
  notes: null,
  adminNotes: null,
  metadata: {},
  locationMetadata: null,
  userId: "user-1",
  idempotencyKey: null,
  idempotencyExpiresAt: null,
  createdAt,
  updatedAt: createdAt,
});

describe("TransactionModel keyset pagination", () => {
  beforeEach(() => {
    mockQueryRead.mockReset();
    mockQueryRead.mockResolvedValue({ rows: [] });
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockQueryWrite.mockReset();
    jest.mocked(CachedTransactionInvalidation.invalidateUserCaches).mockReset();
    jest.mocked(CachedTransactionInvalidation.invalidateProviderStats).mockReset();
    jest.mocked(CachedTransactionInvalidation.invalidateGeneralStats).mockReset();
  });

  it("uses created_at and id ordering for the first history page", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [row("b", "2026-05-02T00:00:00.000Z")],
    });

    const model = new TransactionModel();
    const result = await model.list(25, 0);

    expect(result).toHaveLength(1);
    expect(mockQueryRead).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY created_at DESC, id DESC"),
      [25],
    );
    expect(mockQueryRead.mock.calls[0][0]).not.toContain("OFFSET");
  });

  it("turns offset pages into an anchor lookup plus keyset comparison", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        row("page-101-a", "2026-02-01T00:00:00.000Z"),
        row("page-101-b", "2026-01-31T00:00:00.000Z"),
      ],
    });

    const model = new TransactionModel();
    const result = await model.list(2, 200);

    expect(result.map((tx) => tx.id)).toEqual(["page-101-a", "page-101-b"]);

    const [sql, params] = mockQueryRead.mock.calls[0];
    expect(sql).toContain("WITH anchor AS");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("AND (created_at, id) < (SELECT created_at, id FROM anchor)");
    expect(params).toEqual([199, 2]);
  });

  it("applies after cursors with a created_at/id keyset comparison", async () => {
    const after = Buffer.from(
      "2026-05-02T00:00:00.000Z|00000000-0000-0000-0000-000000000002",
    ).toString("base64");
    mockQueryRead.mockResolvedValueOnce({
      rows: [row("older", "2026-05-01T00:00:00.000Z")],
    });

    const model = new TransactionModel();
    const result = await model.list(10, 0, undefined, undefined, {}, { after });

    expect(result[0].id).toBe("older");
    const [sql, params] = mockQueryRead.mock.calls[0];
    expect(sql).toContain("AND (created_at, id) < ($1, $2)");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(params).toEqual([
      new Date("2026-05-02T00:00:00.000Z"),
      "00000000-0000-0000-0000-000000000002",
      10,
    ]);
  });

  it("keeps status filters compatible with keyset pagination", async () => {
    const model = new TransactionModel();
    await model.findByStatuses([TransactionStatus.Completed], 50, 5000);

    const [sql, params] = mockQueryRead.mock.calls[0];
    expect(sql).toContain("status = ANY($1)");
    expect(sql).toContain("AND (created_at, id) < (SELECT created_at, id FROM anchor)");
    expect(params).toEqual([[TransactionStatus.Completed], 4999, 50]);
  });

  it("invalidates caches after transaction create", async () => {
    const transaction = row("create-1", "2026-05-01T00:00:00.000Z");
    jest.mocked(queryWrite).mockResolvedValueOnce({ rows: [transaction] });

    const model = new TransactionModel();
    await model.create({
      type: "deposit",
      amount: "100",
      phoneNumber: transaction.phoneNumber,
      provider: transaction.provider,
      stellarAddress: transaction.stellarAddress,
      status: TransactionStatus.Pending,
      tags: [],
      userId: transaction.userId,
      metadata: {},
    });

    expect(
      (CachedTransactionInvalidation.invalidateUserCaches as jest.Mock)
        .mock.calls[0][0],
    ).toBe(transaction.userId);
    expect(
      (CachedTransactionInvalidation.invalidateProviderStats as jest.Mock)
        .mock.calls[0][0],
    ).toBe(transaction.provider);
  });

  it("falls back to general stats invalidation when provider is missing", async () => {
    const transaction = row("create-2", "2026-05-02T00:00:00.000Z");
    jest.mocked(queryWrite).mockResolvedValueOnce({ rows: [{ ...transaction, provider: null }] });

    const model = new TransactionModel();
    await model.create({
      type: "withdraw",
      amount: "50",
      phoneNumber: transaction.phoneNumber,
      provider: undefined,
      stellarAddress: transaction.stellarAddress,
      status: TransactionStatus.Pending,
      tags: [],
      userId: transaction.userId,
      metadata: {},
    });

    expect(
      (CachedTransactionInvalidation.invalidateGeneralStats as jest.Mock)
        .mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("invalidates user and provider caches when transaction status updates", async () => {
    jest.mocked(queryWrite).mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          user_id: "user-1",
          provider: "mtn",
          reference_number: "TX-create-1",
          updated_at: "2026-05-03T00:00:00.000Z",
        },
      ],
    });

    const model = new TransactionModel();
    await model.updateStatus("create-1", TransactionStatus.Completed);

    expect(
      (CachedTransactionInvalidation.invalidateUserCaches as jest.Mock)
        .mock.calls[0][0],
    ).toBe("user-1");
    expect(
      (CachedTransactionInvalidation.invalidateProviderStats as jest.Mock)
        .mock.calls[0][0],
    ).toBe("mtn");
  });
});
