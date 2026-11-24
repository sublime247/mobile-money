const mockQuery = jest.fn();
const mockReleaseAllExpiredIdempotencyKeys = jest.fn();
const mockRunKycRetentionPurge = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    releaseAllExpiredIdempotencyKeys: mockReleaseAllExpiredIdempotencyKeys,
  })),
}));

jest.mock("../../services/kycRetentionService", () => ({
  runKycRetentionPurge: (...args: unknown[]) => mockRunKycRetentionPurge(...args),
}));

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import { runCleanupJob } from "../cleanupJob";

describe("runCleanupJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOG_RETENTION_DAYS = "90";
    mockReleaseAllExpiredIdempotencyKeys.mockResolvedValue(2);
    mockQuery.mockResolvedValue({ rowCount: 3 });
    mockRunKycRetentionPurge.mockResolvedValue({ purgedCount: 1, skippedCount: 0, deletedS3Objects: 2, errors: [] });
  });

  it("deletes old terminal transactions and runs KYC retention purge", async () => {
    await runCleanupJob();

    expect(mockReleaseAllExpiredIdempotencyKeys).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM transactions"),
    );
    expect(mockRunKycRetentionPurge).toHaveBeenCalled();
  });

  it("does not fail cleanup when KYC purge throws", async () => {
    mockRunKycRetentionPurge.mockRejectedValueOnce(new Error("purge failed"));

    await expect(runCleanupJob()).resolves.toBeUndefined();
  });
});
