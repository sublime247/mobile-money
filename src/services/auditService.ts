import crypto from "crypto";
import { AuditLogModel, AuditLog, CreateAuditLogInput } from "../models/auditLog";
import logger from "../utils/logger";
import archiver from "archiver";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { pool } from "../config/database";
import { getS3Client, s3Config } from "../config/s3";
import { signReport } from "../security/reportSigner";
import { createAuditManifest } from "../utils/auditManifest";

export class InvalidAuditRangeError extends Error {}

/** Explicit UTC timestamps; the export interval is [start, end). */
export function validateAuditRange(start: string, end: string): void {
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const valid = (value: string) =>
    typeof value === "string" &&
    timestamp.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() ===
      value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
  if (!valid(start) || !valid(end) || Date.parse(start) >= Date.parse(end)) {
    throw new InvalidAuditRangeError(
      "start and end must be UTC ISO timestamps with start before end",
    );
  }
}

function csvCell(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Audit Service with tamper-evident SHA-256 hash chaining.
 * Each audit log entry is linked to the previous entry via a cryptographic hash,
 * making unauthorized database modifications detectable.
 */
export class AuditService {
  /** Builds an all-or-nothing archive; missing documents abort the export. */
  async buildAuditArchive(start: string, end: string): Promise<Buffer> {
    validateAuditRange(start, end);
    const privateKey = process.env.ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY;
    if (!privateKey)
      throw new Error("ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY is not configured");
    // Validate signing configuration before reading sensitive data.
    signReport("", privateKey);
    const client = await pool.connect();
    let transactions: Record<string, unknown>[];
    let documents: {
      id: string;
      user_id: string;
      s3_key: string;
      document_type: string;
      mime_type: string;
    }[];
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactions = (
        await client.query(
          `SELECT id, user_id, reference_number, type, amount, currency, provider, status, created_at
         FROM transactions WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at, id`,
          [start, end],
        )
      ).rows;
      // Include KYC evidence for users whose transactions fall in the requested interval,
      // including documents uploaded before that interval.
      documents = (
        await client.query(
          `SELECT d.id, d.user_id, d.s3_key, d.document_type, d.mime_type FROM kyc_documents d
         WHERE d.created_at < $2 AND EXISTS (
           SELECT 1 FROM transactions t WHERE t.user_id = d.user_id
           AND t.created_at >= $1 AND t.created_at < $2)
         ORDER BY d.id`,
          [start, end],
        )
      ).rows;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const headers = [
      "id",
      "user_id",
      "reference_number",
      "type",
      "amount",
      "currency",
      "provider",
      "status",
      "created_at",
    ];
    const files = new Map<string, Buffer>();
    files.set(
      "ledger.csv",
      Buffer.from(
        [
          headers.join(","),
          ...transactions.map((row) =>
            headers.map((key) => csvCell(row[key])).join(","),
          ),
        ].join("\r\n") + "\r\n",
      ),
    );
    files.set(
      "range.json",
      Buffer.from(
        JSON.stringify({
          start,
          end,
          interval: "[start,end)",
          signatureAlgorithm: "RSA-SHA256",
        }),
      ),
    );
    files.set(
      "documents.csv",
      Buffer.from(
        [
          "archive_path,user_id,document_type,mime_type",
          ...documents.map((document) =>
            [
              `documents/${document.id}`,
              document.user_id,
              document.document_type,
              document.mime_type,
            ]
              .map(csvCell)
              .join(","),
          ),
        ].join("\r\n") + "\r\n",
      ),
    );
    for (const document of documents) {
      if (!/^[a-zA-Z0-9-]+$/.test(document.id) || !document.s3_key) {
        throw new Error("Invalid KYC document reference");
      }
      const object = await getS3Client().send(
        new GetObjectCommand({ Bucket: s3Config.bucket, Key: document.s3_key }),
      );
      if (!object.Body) throw new Error("KYC document body is missing");
      files.set(
        `documents/${document.id}`,
        Buffer.from(await object.Body.transformToByteArray()),
      );
    }
    const manifest = createAuditManifest(files);
    const { signature } = signReport(manifest, privateKey);
    files.set("manifest.sha256", manifest);
    files.set("manifest.sig", Buffer.from(signature + "\n"));
    return new Promise<Buffer>((resolve, reject) => {
      const archive = archiver("zip", { zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      archive.once("error", reject);
      archive.once("warning", reject);
      archive.once("end", () => resolve(Buffer.concat(chunks)));
      for (const [name, content] of files) archive.append(content, { name });
      archive.finalize().catch(reject);
    });
  }
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
