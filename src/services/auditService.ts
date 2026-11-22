import crypto from "crypto";
import { AuditLogModel, AuditLog, CreateAuditLogInput } from "../models/auditLog";
import logger from "../utils/logger";

/**
 * Audit Service with tamper-evident SHA-256 hash chaining.
 * Each audit log entry is linked to the previous entry via a cryptographic hash,
 * making unauthorized database modifications detectable.
 */
export class AuditService {
  private auditLogModel: AuditLogModel;

  constructor() {
    this.auditLogModel = new AuditLogModel();
  }

  /**
   * Calculate SHA-256 hash of a payload.
   * @param payload - The data to hash
   * @returns Hex-encoded SHA-256 hash
   */
  private calculatePayloadHash(payload: Record<string, unknown>): string {
    const payloadJson = JSON.stringify(payload);
    return crypto.createHash("sha256").update(payloadJson).digest("hex");
  }

  /**
   * Log an admin action with hash chaining for tamper detection.
   * @param input - Audit log input data
   * @returns The created audit log entry
   */
  async logAdminAction(input: Omit<CreateAuditLogInput, "payloadHash" | "previousEntryHash">): Promise<AuditLog> {
    try {
      // Calculate payload hash
      const payloadHash = this.calculatePayloadHash(input.diff);

      // Get the previous audit log entry to chain the hash
      const previousEntries = await this.auditLogModel.list({
        adminId: input.adminId,
        limit: 1,
      });

      const previousEntryHash = previousEntries[0]?.payloadHash ?? null;

      // Create new audit log with hash chain
      const auditLog = await this.auditLogModel.create({
        ...input,
        payloadHash,
        previousEntryHash,
      });

      logger.info(
        {
          auditLogId: auditLog.id,
          adminId: input.adminId,
          action: input.action,
          resource: input.resource,
        },
        "Admin action logged with hash chaining",
      );

      return auditLog;
    } catch (error) {
      logger.error(
        { error, adminId: input.adminId, action: input.action },
        "Failed to log admin action",
      );
      throw error;
    }
  }

  /**
   * Verify the integrity of audit logs by validating the hash chain.
   * @param adminId - The admin to verify logs for
   * @returns Object containing verification results and any tampering detected
   */
  async verifyIntegrity(adminId: string): Promise<{
    isValid: boolean;
    totalEntries: number;
    tamperedEntries: Array<{ id: string; expected: string; actual: string }>;
    lastVerified: Date;
  }> {
    try {
      const logs = await this.auditLogModel.list({
        adminId,
        limit: 10000, // Verify large batches
      });

      const tamperedEntries: Array<{ id: string; expected: string; actual: string }> = [];

      // Verify hash chain in reverse order (oldest to newest)
      for (let i = logs.length - 1; i >= 0; i--) {
        const currentLog = logs[i];
        const nextLog = i > 0 ? logs[i - 1] : null;

        // Verify that current log's previousEntryHash matches the previous log's payloadHash
        if (nextLog) {
          if (currentLog.previousEntryHash !== nextLog.payloadHash) {
            tamperedEntries.push({
              id: currentLog.id,
              expected: nextLog.payloadHash,
              actual: currentLog.previousEntryHash ?? "null",
            });
          }
        } else {
          // The oldest entry should have no previousEntryHash
          if (currentLog.previousEntryHash !== null) {
            tamperedEntries.push({
              id: currentLog.id,
              expected: "null",
              actual: currentLog.previousEntryHash,
            });
          }
        }

        // Verify that the stored hash matches the calculated hash of the diff
        const recalculatedHash = this.calculatePayloadHash(currentLog.diff);
        if (currentLog.payloadHash !== recalculatedHash) {
          tamperedEntries.push({
            id: currentLog.id,
            expected: recalculatedHash,
            actual: currentLog.payloadHash,
          });
        }
      }

      const isValid = tamperedEntries.length === 0;

      if (!isValid) {
        logger.error(
          {
            adminId,
            tamperedCount: tamperedEntries.length,
            totalEntries: logs.length,
          },
          "Audit log integrity verification failed - tampering detected",
        );
      }

      return {
        isValid,
        totalEntries: logs.length,
        tamperedEntries,
        lastVerified: new Date(),
      };
    } catch (error) {
      logger.error({ error, adminId }, "Failed to verify audit log integrity");
      throw error;
    }
  }

  /**
   * Get audit logs for an admin with full hash chain information.
   * @param adminId - The admin ID
   * @param limit - Maximum number of logs to return
   * @param offset - Offset for pagination
   * @returns Array of audit logs
   */
  async getAdminAuditLogs(
    adminId: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<AuditLog[]> {
    return this.auditLogModel.list({
      adminId,
      limit,
      offset,
    });
  }

  /**
   * Count audit logs for an admin.
   * @param adminId - The admin ID
   * @returns Count of audit logs
   */
  async countAdminAuditLogs(adminId: string): Promise<number> {
    return this.auditLogModel.count({ adminId });
  }
}

// Export singleton instance
export const auditService = new AuditService();
