import crypto from "crypto";
import archiver from "archiver";
import { PassThrough } from "stream";
import { AuditLogModel, AuditLog, CreateAuditLogInput } from "../models/auditLog";
import logger from "../utils/logger";
import { pool } from "../config/database";

export interface AuditExportOptions {
  from: Date;
  to: Date;
  includeKycDocuments?: boolean;
  signingKey?: string;
}

export interface AuditManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface AuditExportManifest {
  generatedAt: string;
  from: string;
  to: string;
  files: AuditManifestFile[];
}

export interface AuditExportResult {
  archive: PassThrough;
  manifest: AuditExportManifest;
  manifestSignature: string;
}

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

  static sha256(content: Buffer | string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  static signManifest(manifestJson: string, signingKey?: string): string {
    const key =
      signingKey ||
      process.env.AUDIT_EXPORT_SIGNING_KEY ||
      process.env.COMPLIANCE_MASTER_PRIVATE_KEY;
    if (key) {
      try {
        const signer = crypto.createSign("SHA256");
        signer.update(manifestJson);
        signer.end();
        return signer.sign(key, "base64");
      } catch {
        const hmac = crypto.createHmac("sha256", key).update(manifestJson).digest("base64");
        return `hmac-sha256:${hmac}`;
      }
    }
    return `unsigned:${AuditService.sha256(manifestJson)}`;
  }

  static toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      const str = typeof value === "string" ? value : JSON.stringify(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => escape(row[h])).join(","));
    }
    return lines.join("\n") + "\n";
  }

  async buildAuditExportArchive(options: AuditExportOptions): Promise<AuditExportResult> {
    const { from, to } = options;
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) throw new Error("Invalid from date");
    if (!(to instanceof Date) || Number.isNaN(to.getTime())) throw new Error("Invalid to date");
    if (from > to) throw new Error("from must be before or equal to to");

    const txResult = await pool.query(
      `SELECT id, reference_number, type, amount, status, provider, user_id, created_at, updated_at, metadata
       FROM transactions WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC`,
      [from.toISOString(), to.toISOString()],
    );
    const auditResult = await pool.query(
      `SELECT id, admin_id, action, resource, resource_id, diff, payload_hash, previous_entry_hash, created_at
       FROM audit_logs WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC`,
      [from.toISOString(), to.toISOString()],
    );

    let kycRows: Record<string, unknown>[] = [];
    if (options.includeKycDocuments !== false) {
      try {
        const kycResult = await pool.query(
          `SELECT id, user_id, applicant_id, document_type, document_side, file_url, s3_key, original_filename, file_size, mime_type, created_at
           FROM kyc_documents WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC`,
          [from.toISOString(), to.toISOString()],
        );
        kycRows = kycResult.rows;
      } catch {
        kycRows = [];
      }
    }

    const files: Array<{ path: string; content: Buffer }> = [
      { path: "ledger/transactions.csv", content: Buffer.from(AuditService.toCsv(txResult.rows), "utf8") },
      { path: "audit/audit_logs.csv", content: Buffer.from(AuditService.toCsv(auditResult.rows), "utf8") },
    ];
    if (options.includeKycDocuments !== false) {
      files.push({ path: "kyc/documents.csv", content: Buffer.from(AuditService.toCsv(kycRows), "utf8") });
    }

    const manifest: AuditExportManifest = {
      generatedAt: new Date().toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
      files: files.map((f) => ({ path: f.path, sha256: AuditService.sha256(f.content), bytes: f.content.byteLength })),
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestSignature = AuditService.signManifest(manifestJson, options.signingKey);

    const archive = archiver("zip", { zlib: { level: 9 } });
    const output = new PassThrough();
    archive.pipe(output);
    for (const file of files) archive.append(file.content, { name: file.path });
    archive.append(manifestJson, { name: "manifest.json" });
    archive.append(manifestSignature + "\n", { name: "manifest.sig" });
    void archive.finalize().catch((err) => output.destroy(err as Error));

    return { archive: output, manifest, manifestSignature };
  }
}

// Export singleton instance
export const auditService = new AuditService();
