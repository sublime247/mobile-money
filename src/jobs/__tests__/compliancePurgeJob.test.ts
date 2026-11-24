const mockRunKycRetentionPurge = jest.fn();

jest.mock("../../services/kycRetentionService", () => ({
  runKycRetentionPurge: (...args: unknown[]) => mockRunKycRetentionPurge(...args),
}));

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import { runKycRetentionPurgeJob } from "../kycRetentionPurgeJob";

describe("runKycRetentionPurgeJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("runs retention purge and completes when no errors", async () => {
    mockRunKycRetentionPurge.mockResolvedValue({ purgedCount: 2, skippedCount: 0, deletedS3Objects: 3, errors: [] });
    await expect(runKycRetentionPurgeJob()).resolves.toBeUndefined();
    expect(mockRunKycRetentionPurge).toHaveBeenCalled();
  });

  it("completes when purge reports record errors", async () => {
    mockRunKycRetentionPurge.mockResolvedValue({ purgedCount: 0, skippedCount: 1, deletedS3Objects: 0, errors: ["Record x: fail"] });
    await expect(runKycRetentionPurgeJob()).resolves.toBeUndefined();
  });
});
