const mockQuery = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

import logger from "../../utils/logger";
import {
  countDefaultPartitionRows,
  ensureAuditLogPartitions,
  pruneAuditLogPartitions,
  runPartitionManagerJob,
} from "../partitionManager";

describe("partitionManager", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
  });

  describe("ensureAuditLogPartitions", () => {
    it("calls ensure_audit_logs_partitions and returns created names", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ partition: "audit_logs_2027_01" }],
      });

      const created = await ensureAuditLogPartitions(4);

      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT ensure_audit_logs_partitions($1) AS partition",
        [4],
      );
      expect(created).toEqual(["audit_logs_2027_01"]);
    });

    it("defaults to 3 months ahead", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await ensureAuditLogPartitions();

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [3]);
    });
  });

  describe("countDefaultPartitionRows", () => {
    it("parses the DEFAULT partition row count", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "12" }] });

      await expect(countDefaultPartitionRows()).resolves.toBe(12);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("FROM audit_logs_legacy"),
      );
    });
  });

  describe("pruneAuditLogPartitions", () => {
    it("detaches and drops old monthly partitions", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ cutoff: "2025-11-01" }] })
        .mockResolvedValueOnce({ rows: [{ partition_name: "audit_logs_2025_10" }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });

      const pruned = await pruneAuditLogPartitions(12);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ALTER TABLE audit_logs DETACH PARTITION"),
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DROP TABLE IF EXISTS"),
      );
      expect(pruned).toEqual([
        { partition: "audit_logs_2025_10", archivedRows: 0, dropped: true },
      ]);
    });
  });

  describe("runPartitionManagerJob", () => {
    it("logs created partitions", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ partition: "audit_logs_2027_01" }] })
        .mockResolvedValueOnce({ rows: [{ cutoff: "2025-11-01" }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await runPartitionManagerJob();

      expect(logger.info).toHaveBeenCalledWith(
        { created: ["audit_logs_2027_01"] },
        "[PartitionManager] Created audit_logs partitions",
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("warns when rows have landed in the DEFAULT partition", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ cutoff: "2025-11-01" }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "5" }] });

      await runPartitionManagerJob();

      expect(logger.warn).toHaveBeenCalledWith(
        { defaultRows: 5 },
        expect.stringContaining("DEFAULT partition"),
      );
    });

    it("logs and swallows partition creation errors", async () => {
      const error = new Error("default partition would be violated");
      mockQuery.mockRejectedValueOnce(error);

      await expect(runPartitionManagerJob()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        { error },
        "[PartitionManager] Failed to create audit_logs partitions",
      );
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
