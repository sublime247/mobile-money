import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { v4 as uuid } from "uuid";
import { Transaction, TransactionModel } from "../models/transaction";
import { logAuditEvent } from "../utils/log-audit-event";
import { AuditLog, auditService } from "./auditlogService";
import { TransactionService } from "./transactionService";
import {
  deactivateUserAccount,
  getUserById,
  updateUserById,
  User,
} from "./userService";
import { getS3Client, s3Config } from "../config/s3";
import { pool } from "../config/database";

export class GDPRService {
  private txService: TransactionService;

  constructor() {
    this.txService = new TransactionService(new TransactionModel());
  }

  private serializeUser(user: User) {
    return {
      id: user.id,
      phone_number: user.phone_number,
      kyc_level: user.kyc_level,
      role_name: user.role_name ?? null,
      display_name: user.display_name ?? null,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  private serializeTransaction(tx: Transaction) {
    return {
      id: tx.id,
      referenceNumber: tx.referenceNumber,
      type: tx.type,
      amount: tx.amount,
      provider: tx.provider,
      status: tx.status,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  }

  /**
   * Export user data as an in-memory ZIP buffer.
   *
   * Security: No files are written to the local filesystem at any point.
   * All data passes through memory-buffered streams only before being
   * returned to the caller for direct HTTP streaming — satisfying the
   * requirement to keep sensitive data out of local disk storage.
   */
  async exportUserData(userId: string): Promise<Buffer> {
    const user = await getUserById(userId);
    const txs = await this.txService.findByUserId(userId);

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const passthrough = new PassThrough();

      passthrough.on("data", (chunk: Buffer) => chunks.push(chunk));
      passthrough.on("end", () => resolve(Buffer.concat(chunks)));
      passthrough.on("error", reject);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", reject);
      archive.pipe(passthrough);

      // Append each export file directly as in-memory buffers — no disk I/O.
      archive.append(Buffer.from(JSON.stringify(this.serializeUser(user!), null, 2), "utf8"), {
        name: "profile.json",
      });
      archive.append(Buffer.from(JSON.stringify(txs.map(tx => this.serializeTransaction(tx)), null, 2), "utf8"), {
        name: "transactions.json",
      });

      archive.finalize();
    });
  }

  private hashString(str: string) {
    return crypto
      .createHash("sha256")
      .update(str)
      .digest("hex")
      .substring(0, 16);
  }

  anonymizeTransaction(tx: Transaction) {
    return {
      ...tx,
      phoneNumber: tx.phoneNumber
        ? this.hashString(tx.phoneNumber)
        : tx.phoneNumber,
      idempotencyKey: tx.idempotencyKey
        ? this.hashString(String(tx.idempotencyKey))
        : tx.idempotencyKey,
      stellarAddress: tx.stellarAddress
        ? this.hashString(tx.stellarAddress)
        : tx.stellarAddress,
    };
  }

  anonymizeEmail(email: string) {
    return `${this.hashString(email).slice(4, 8)}-${uuid()}@anonymized.local`;
  }

  anonymizePhoneNumber(phone: string) {
    return this.hashString(phone);
  }

  anonymizeStellaAddress(addr: string) {
    return this.hashString(addr);
  }

  anonymizeBackupCode(code: string[]) {
    return code.map((c) => this.hashString(c));
  }

  async purgeUserData(userId: string) {
    try {
      // Anonymize tx records
      const transactions = await this.txService.findByUserId(userId);
      for (const tx of transactions) {
        const anonymizedTx = this.anonymizeTransaction(tx);
        await pool.query(
          `UPDATE transactions SET phone_number = $1, idempotency_key = $2, stellar_address = $3 WHERE id = $4`,
          [
            anonymizedTx.phoneNumber,
            anonymizedTx.idempotencyKey,
            anonymizedTx.stellarAddress,
            tx.id,
          ],
        );
      }

      // Purge PII from user profile
      const user = await getUserById(userId);
      const anonymizedUser = {
        ...user,
        phone_number: this.anonymizePhoneNumber(String(user?.phone_number)),
        backup_codes: user?.backup_codes
          ? this.anonymizeBackupCode(user?.backup_codes)
          : [],
      } as User;

      await updateUserById(userId, anonymizedUser);

      // Purge PII from audit logs
      const auditLogs = await auditService.fetchAuditLogs(userId);
      for (const log of auditLogs) {
        const anonymizedLog: AuditLog = {
          ...log,
          action: this.hashString(log.action),
        };
        await auditService.updateAuditLog(anonymizedLog);
      }

      // Log erasure event
      await logAuditEvent(userId, "RIGHT_TO_BE_FORGOTTEN_EXECUTED");
      await this.deleteUserS3Objects(userId);
      await this.deleteUserAttachments(userId);

      // Disable/deactivate user account
      await this.deactivateUserAccount(userId);
    } catch (err) {
      console.error("Erasure error:", err);
      throw err;
    }
  }

  /**
   * Enforces data retention policy by identifying and purging expired records.
   * Runs on a schedule (e.g., cron job) to ensure GDPR compliance.
   * @param retentionYears The legally required retention period (default 7 years)
   */
  async enforceDataRetentionPolicy(
    retentionYears: number = 7,
  ): Promise<{ usersPurged: number; transactionsAnonymized: number }> {
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - retentionYears);

    let usersPurged = 0;
    let transactionsAnonymized = 0;

    // 1. Identify and purge deactivated users older than retention period
    const deactivatedUsers = await pool.query(
      `SELECT id, phone_number FROM users WHERE is_active = false AND deactivated_at < $1`,
      [cutoffDate],
    );

    for (const row of deactivatedUsers.rows) {
      const phone = row.phone_number ? String(row.phone_number) : "";
      if (phone.length === 16 && !phone.includes("+")) continue; // Already anonymized

      try {
        await this.purgeUserData(row.id);
        usersPurged++;
      } catch (err) {
        console.error(`[GDPR] Failed to purge expired user ${row.id}:`, err);
      }
    }

    // 2. Identify and anonymize old standalone transactions
    const oldTransactions = await pool.query(
      `SELECT id, phone_number FROM transactions WHERE created_at < $1`,
      [cutoffDate],
    );

    for (const row of oldTransactions.rows) {
      const phone = row.phone_number ? String(row.phone_number) : "";
      if (phone.length === 16 && !phone.includes("+")) continue; // Already anonymized

      try {
        const hashedPhone = phone ? this.anonymizePhoneNumber(phone) : null;
        const hashedIdempotency = this.hashString(row.id);
        const hashedStellar = this.hashString("purged_stellar_address");

        await pool.query(
          `UPDATE transactions SET phone_number = $1, stellar_address = $2, idempotency_key = $3 WHERE id = $4`,
          [hashedPhone, hashedStellar, hashedIdempotency, row.id],
        );
        transactionsAnonymized++;
      } catch (err) {
        console.error(
          `[GDPR] Failed to anonymize expired transaction ${row.id}:`,
          err,
        );
      }
    }

    if (usersPurged > 0 || transactionsAnonymized > 0) {
      await logAuditEvent(
        "SYSTEM",
        `DATA_RETENTION_POLICY_EXECUTED: Purged ${usersPurged} users and ${transactionsAnonymized} transactions older than ${retentionYears} years.`,
      );
    }

    return { usersPurged, transactionsAnonymized };
  }

  private async deactivateUserAccount(userId: string) {
    await deactivateUserAccount(userId);
  }

  private async deleteUserS3Objects(userId: string) {
    const s3 = getS3Client();
    const prefix = `${userId}/`;
    try {
      const listResult = await s3.send(
        new ListObjectsV2Command({ Bucket: s3Config.bucket, Prefix: prefix }),
      );
      const objects = listResult.Contents || [];
      for (const obj of objects) {
        if (obj.Key) {
          await s3.send(
            new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: obj.Key }),
          );
        }
      }
    } catch (err) {
      console.error("S3 deletion error for user", userId, err);
    }
  }

  private async deleteUserAttachments(userId: string) {
    const s3 = getS3Client();
    const prefix = "kyc-documents/";
    let continuationToken: string | undefined = undefined;
    do {
      const listCmd = new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const result = await s3.send(listCmd);
      const objects =
        result.Contents?.filter((obj) =>
          obj.Key?.includes(`/${userId}/`),
        ) ?? [];
      for (const obj of objects) {
        if (obj.Key) {
          const delCmd = new DeleteObjectCommand({
            Bucket: s3Config.bucket,
            Key: obj.Key,
          });
          await s3.send(delCmd);
        }
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
  }
}
