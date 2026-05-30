import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getS3Client, s3Config } from "../config/s3";

  async deleteUserS3Objects(userId: string) {
    const s3 = getS3Client();
    const prefix = `${userId}/`;
    try {
      const listResult = await s3.send(new ListObjectsV2Command({ Bucket: s3Config.bucket, Prefix: prefix }));
      const objects = listResult.Contents || [];
      for (const obj of objects) {
        if (obj.Key) {
          await s3.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: obj.Key }));
        }
      }
    } catch (err) {
      console.error("S3 deletion error for user", userId, err);
    }
  }
import path from "node:path";
import { v4 as uuid } from "uuid";
import { Transaction, TransactionModel } from "../models/transaction";
import { createZipFile } from "../utils/create-zip-file";
import { logAuditEvent } from "../utils/log-audit-event";
import { AuditLog, auditService } from "./auditlogService";
import { TransactionService } from "./transanctionService";

import {
  deactivateUserAccount,
  getUserById,
  updateUserById,
  User,
} from "./userService";
import { pool } from "../config/database";

export class GDPRService {
  private txService: TransactionService;

  constructor() {
    this.txService = new TransactionService(new TransactionModel());
  }

  async exportUserData(userId: string) {
    const tempDir = path.join("/temp", `export-${uuid}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const user = await getUserById(userId);
      const txs = await this.txService.findByUserId(userId);
      // const auditLogs = await getAuditLogs(userId); // Only if there is a user log tray

      // Creat JSON files
      await fs.writeFile(
        path.join(tempDir, "profile.json"),
        JSON.stringify(user, null, 2),
      );
      await fs.writeFile(
        path.join(tempDir, "transactions.json"),
        JSON.stringify(txs, null, 2),
      );
      // await fs.writeFile(path.join(tempDir, 'transactions.json'), JSON.stringify(auditLogs, null, 2));

      // Create zip file
      const zipPath = path.join(
        "/temp",
        `gdpr-export-${userId}-${Date.now()}.zip`,
      );
      await createZipFile(tempDir, zipPath);

      // Cleanup
      await fs.rm(tempDir, { recursive: true });

      return zipPath;
    } catch (err) {
      await fs.rm(tempDir, { recursive: true }).catch(() => {});
      throw err;
    }
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
      phoneNumber: tx.phoneNumber ? this.hashString(tx.phoneNumber) : tx.phoneNumber,
      idempotencyKey: tx.idempotencyKey ? this.hashString(String(tx.idempotencyKey)) : tx.idempotencyKey,
      stellarAddress: tx.stellarAddress ? this.hashString(tx.stellarAddress) : tx.stellarAddress,
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
          [anonymizedTx.phoneNumber, anonymizedTx.idempotencyKey, anonymizedTx.stellarAddress, tx.id]
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

      // Purge PII from audit logs - this uses MOCK at the moment

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
      // Disable/deactivate user accout
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
  async enforceDataRetentionPolicy(retentionYears: number = 7): Promise<{ usersPurged: number, transactionsAnonymized: number }> {
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - retentionYears);

    let usersPurged = 0;
    let transactionsAnonymized = 0;

    // 1. Identify and purge deactivated users older than retention period
    const deactivatedUsers = await pool.query(
      `SELECT id, phone_number FROM users WHERE is_active = false AND deactivated_at < $1`,
      [cutoffDate]
    );

    for (const row of deactivatedUsers.rows) {
      const phone = row.phone_number ? String(row.phone_number) : '';
      if (phone.length === 16 && !phone.includes('+')) continue; // Already anonymized
      
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
      [cutoffDate]
    );

    for (const row of oldTransactions.rows) {
      const phone = row.phone_number ? String(row.phone_number) : '';
      if (phone.length === 16 && !phone.includes('+')) continue; // Already anonymized

      try {
        const hashedPhone = phone ? this.anonymizePhoneNumber(phone) : null;
        const hashedIdempotency = this.hashString(row.id);
        const hashedStellar = this.hashString('purged_stellar_address');

        await pool.query(
          `UPDATE transactions SET phone_number = $1, stellar_address = $2, idempotency_key = $3 WHERE id = $4`,
          [hashedPhone, hashedStellar, hashedIdempotency, row.id]
        );
        transactionsAnonymized++;
      } catch (err) {
        console.error(`[GDPR] Failed to anonymize expired transaction ${row.id}:`, err);
      }
    }

    if (usersPurged > 0 || transactionsAnonymized > 0) {
      await logAuditEvent(
        'SYSTEM',
        `DATA_RETENTION_POLICY_EXECUTED: Purged ${usersPurged} users and ${transactionsAnonymized} transactions older than ${retentionYears} years.`
      );
    }

    return { usersPurged, transactionsAnonymized };
  }

  private async deactivateUserAccount(userId: string) {
    await deactivateUserAccount(userId);
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
      const objects = result.Contents?.filter((obj) => obj.Key?.includes(`/${userId}/`)) ?? [];
      for (const obj of objects) {
        if (obj.Key) {
          const delCmd = new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: obj.Key });
          await s3.send(delCmd);
        }
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
  }
}
