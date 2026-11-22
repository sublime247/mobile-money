import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import logger from "../utils/logger";
import { queryRead } from "../config/database";
import { env } from "../config/env";
import { encryptAesGcmToBuffer } from "../crypto/aesGcm";
import { emailService } from "../services/email";

/**
 * Daily Suspicious Activity Report (SAR) summary.
 *
 * Runs at midnight UTC and aggregates the previous UTC day's flagged
 * transactions (AML alerts), velocity rule breaches and rejected KYC
 * submissions into a JSON report. The report is encrypted (AES-256-GCM) into
 * the compliance archive and a summary is sent to the compliance team.
 */

const ARCHIVE_DIR =
  process.env.COMPLIANCE_ARCHIVE_DIR || path.resolve("compliance-archive");

export interface DailySarReport {
  reportDate: string;
  generatedAt: string;
  summary: {
    flaggedTransactions: number;
    highSeverityAlerts: number;
    velocityBreaches: number;
    rejectedKycSubmissions: number;
  };
  flaggedTransactions: Array<Record<string, unknown>>;
  velocityBreaches: Array<Record<string, unknown>>;
  rejectedKycSubmissions: Array<Record<string, unknown>>;
}

/** Previous UTC day as [start, end). */
export function getReportWindow(now: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start: new Date(end.getTime() - 24 * 60 * 60 * 1000), end };
}

export async function buildDailySarReport(
  now: Date = new Date(),
): Promise<DailySarReport> {
  const { start, end } = getReportWindow(now);

  const [alerts, kyc] = await Promise.all([
    queryRead(
      `SELECT id, transaction_id AS "transactionId", user_id AS "userId",
              severity, status, rule_hits AS "ruleHits", reasons,
              created_at AS "createdAt"
         FROM aml_alerts
        WHERE created_at >= $1 AND created_at < $2
        ORDER BY created_at`,
      [start, end],
    ),
    queryRead(
      `SELECT id, user_id AS "userId", kyc_level AS "kycLevel",
              updated_at AS "rejectedAt"
         FROM kyc_applicants
        WHERE verification_status = 'rejected'
          AND updated_at >= $1 AND updated_at < $2
        ORDER BY updated_at`,
      [start, end],
    ),
  ]);

  const flagged = alerts.rows as Array<Record<string, any>>;
  const velocityBreaches = flagged.filter((a) =>
    (Array.isArray(a.ruleHits) ? a.ruleHits : []).some(
      (hit: { rule?: string }) => hit.rule === "velocity_threshold",
    ),
  );

  return {
    reportDate: start.toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    summary: {
      flaggedTransactions: flagged.length,
      highSeverityAlerts: flagged.filter((a) => a.severity === "high").length,
      velocityBreaches: velocityBreaches.length,
      rejectedKycSubmissions: kyc.rows.length,
    },
    flaggedTransactions: flagged,
    velocityBreaches,
    rejectedKycSubmissions: kyc.rows,
  };
}

/** Encrypts the report into the compliance archive and returns the file path. */
export function archiveReport(report: DailySarReport): string {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      env.DB_ENCRYPTION_KEY,
      Buffer.from("sar-archive"),
      Buffer.from("daily-sar-report"),
      32,
    ),
  );
  const encrypted = encryptAesGcmToBuffer(
    Buffer.from(JSON.stringify(report, null, 2)),
    key,
  );

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(ARCHIVE_DIR, `sar-summary-${report.reportDate}.json.enc`);
  fs.writeFileSync(file, encrypted, { mode: 0o600 });
  return file;
}

async function notifyComplianceTeam(
  report: DailySarReport,
  archivePath: string,
): Promise<void> {
  const { summary } = report;
  const text =
    `Daily SAR summary for ${report.reportDate}: ` +
    `${summary.flaggedTransactions} flagged transactions ` +
    `(${summary.highSeverityAlerts} high severity), ` +
    `${summary.velocityBreaches} velocity breaches, ` +
    `${summary.rejectedKycSubmissions} rejected KYC submissions. ` +
    `Archived: ${path.basename(archivePath)}`;

  const webhookUrl = process.env.COMPLIANCE_WEBHOOK_URL;
  if (webhookUrl) {
    // `text` for Slack, `content` for Discord.
    await axios
      .post(webhookUrl, { text, content: text, summary }, { timeout: 5000 })
      .catch((err) =>
        logger.error({ err: err.message }, "[sar-summary] Webhook delivery failed"),
      );
  }

  const email = process.env.COMPLIANCE_EMAIL;
  const templateId = process.env.SENDGRID_SAR_SUMMARY_TEMPLATE_ID;
  if (email && templateId) {
    await emailService.sendEmail({
      to: email,
      templateId,
      dynamicTemplateData: { reportDate: report.reportDate, ...summary },
    });
  }

  if (!webhookUrl && !(email && templateId)) {
    logger.warn(
      "[sar-summary] No COMPLIANCE_WEBHOOK_URL or COMPLIANCE_EMAIL configured; summary not sent",
    );
  }
}

export async function runDailySarSummaryJob(): Promise<void> {
  const report = await buildDailySarReport();
  const archivePath = archiveReport(report);
  logger.info(
    { reportDate: report.reportDate, ...report.summary, archivePath },
    "[sar-summary] Daily SAR summary archived",
  );
  await notifyComplianceTeam(report, archivePath);
}
