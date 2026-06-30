const mockPoolQuery = jest.fn();
const mockReleaseAllExpiredIdempotencyKeys = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    releaseAllExpiredIdempotencyKeys: (...args: unknown[]) =>
      mockReleaseAllExpiredIdempotencyKeys(...args),
  })),
}));

import { runCleanupJob } from "../../src/jobs/cleanupJob";

describe("runCleanupJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseAllExpiredIdempotencyKeys.mockResolvedValue(4);
    mockPoolQuery.mockResolvedValue({ rowCount: 7 });
  });

  it("clears expired idempotency keys before deleting aged terminal transactions", async () => {
    await runCleanupJob();

    expect(mockReleaseAllExpiredIdempotencyKeys).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0][0]).toContain(
      "DELETE FROM transactions",
    );
  });
});
