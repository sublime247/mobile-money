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

describe("kycRetentionPurgeJob", () => {
  it("invokes retention service", async () => {
    mockRunKycRetentionPurge.mockResolvedValue({ purgedCount: 0, skippedCount: 0, deletedS3Objects: 0, errors: [] });
    await runKycRetentionPurgeJob();
    expect(mockRunKycRetentionPurge).toHaveBeenCalledTimes(1);
  });
});
