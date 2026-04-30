import sgMail from "@sendgrid/mail";
import { Transaction } from "../models/transaction";
import { DailySnapshot } from "../models/snapshot";
import { GrowthMetrics } from "./snapshotService";
import { resolveLocale, translate } from "../utils/i18n";

export interface LockoutEmailOptions {
  minutesRemaining: number;
  unlocksAt: Date;
  ipAddress?: string;
  locale?: string;
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

export interface EmailOptions {
  to: string;
  templateId: string;
  dynamicTemplateData: Record<string, any>;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: string;
  }>;
}

export interface VulnerabilityReport {
  total: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
}

export class EmailService {
  private resolveTemplateId(
    baseEnvName: "SENDGRID_RECEIPT_TEMPLATE_ID" | "SENDGRID_FAILURE_TEMPLATE_ID",
    locale: string,
  ): string {
    const resolvedLocale = resolveLocale(locale).toUpperCase();
    const localizedEnvKey = `${baseEnvName}_${resolvedLocale}`;

    return process.env[localizedEnvKey] || process.env[baseEnvName] || "";
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      console.log("Skipping email send in test environment");
      return;
    }

    try {
      await sgMail.send({
        from: process.env.EMAIL_FROM || '"Mobile Money" <no-reply@mobilemoney.com>',
        to: options.to,
        templateId: options.templateId,
        dynamicTemplateData: options.dynamicTemplateData,
        attachments: options.attachments,
      });
    } catch (error) {
      console.error("Email delivery failed:", error);
      // We don't throw here to prevent blocking the transaction flow
      // but in a real app, we might want to retry or log to a dedicated service
    }
  }

  async sendTransactionReceipt(
    email: string,
    transaction: Transaction,
    locale = "en",
  ): Promise<void> {
    const resolvedLocale = resolveLocale(locale);
    await this.sendEmail({
      to: email,
      templateId: this.resolveTemplateId(
        "SENDGRID_RECEIPT_TEMPLATE_ID",
        resolvedLocale,
      ),
      dynamicTemplateData: {
        amount: transaction.amount,
        type: transaction.type,
        typeLocalized: translate(
          `email.transaction_type.${transaction.type}`,
          resolvedLocale,
        ),
        referenceNumber: transaction.referenceNumber,
        provider: transaction.provider.toUpperCase(),
        phoneNumber: transaction.phoneNumber,
        stellarAddress: transaction.stellarAddress,
        transactionHash: txHash,
        stellarExpertUrl,
        createdAt: new Date(transaction.createdAt).toLocaleString(resolvedLocale),
        locale: resolvedLocale,
        year: new Date().getFullYear(),
      },
    });
  }

  async sendAccountLockoutNotification(
    email: string,
    options: LockoutEmailOptions,
  ): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      console.log("Skipping lockout email in test environment");
      return;
    }

    const { minutesRemaining, unlocksAt, ipAddress, locale = "en" } = options;
    const resolvedLocale = resolveLocale(locale);

    const templateId = process.env.SENDGRID_LOCKOUT_TEMPLATE_ID;
    const from =
      process.env.EMAIL_FROM || '"Mobile Money" <no-reply@mobilemoney.com>';

    try {
      if (templateId) {
        await sgMail.send({
          from,
          to: email,
          templateId,
          dynamicTemplateData: {
            minutesRemaining,
            unlocksAt: unlocksAt.toISOString(),
            unlocksAtLocalized: unlocksAt.toLocaleString(resolvedLocale),
            ipAddress: ipAddress ?? "unknown",
            locale: resolvedLocale,
            year: new Date().getFullYear(),
          },
        });
      } else {
        // Inline HTML fallback — no template required in SendGrid.
        const unlockTime = unlocksAt.toLocaleString(resolvedLocale);
        const ipNote = ipAddress
          ? `<p style="color:#666;font-size:13px;">Request originated from IP: ${ipAddress}</p>`
          : "";

        await sgMail.send({
          from,
          to: email,
          subject: "Your account has been temporarily locked",
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
              <h2 style="color:#c0392b">Account Temporarily Locked</h2>
              <p>We detected multiple failed login attempts on your Mobile Money account.</p>
              <p>For your security, your account has been <strong>temporarily locked for ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}</strong>.</p>
              <p>You will be able to log in again after:<br>
                <strong>${unlockTime}</strong>
              </p>
              ${ipNote}
              <p>If this wasn't you, please contact our support team immediately.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#999;font-size:12px">
                &copy; ${new Date().getFullYear()} Mobile Money. This is an automated security notification.
              </p>
            </div>
          `,
          text:
            `Your Mobile Money account has been temporarily locked due to multiple failed login attempts.\n\n` +
            `You can try again in ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"} (after ${unlockTime}).\n\n` +
            `If this wasn't you, please contact support immediately.`,
        });
      }
    } catch (error) {
      console.error("[Email] Lockout notification delivery failed:", error);
    }
  }

  async sendTransactionFailure(
    email: string,
    transaction: Transaction,
    reason: string,
    locale = "en",
  ): Promise<void> {
    const resolvedLocale = resolveLocale(locale);
    await this.sendEmail({
      to: email,
      templateId: this.resolveTemplateId(
        "SENDGRID_FAILURE_TEMPLATE_ID",
        resolvedLocale,
      ),
      dynamicTemplateData: {
        amount: transaction.amount,
        type: transaction.type,
        typeLocalized: translate(
          `email.transaction_type.${transaction.type}`,
          resolvedLocale,
        ),
        referenceNumber: transaction.referenceNumber,
        reason,
        reasonLabel: translate("email.labels.reason", resolvedLocale),
        locale: resolvedLocale,
        year: new Date().getFullYear(),
      },
    });
  }

  async sendManagementSummary(
    email: string,
    snapshot: DailySnapshot,
    growth: GrowthMetrics,
  ): Promise<void> {
    const templateId = process.env.SENDGRID_MANAGEMENT_SUMMARY_TEMPLATE_ID;
    const from = process.env.EMAIL_FROM || '"Mobile Money" <no-reply@mobilemoney.com>';

    if (templateId) {
      await this.sendEmail({
        to: email,
        templateId,
        dynamicTemplateData: {
          snapshotDate: snapshot.snapshotDate,
          totalBalance: snapshot.totalBalance,
          totalMainBalance: snapshot.totalMainBalance,
          totalVaultBalance: snapshot.totalVaultBalance,
          dailyVolume: snapshot.dailyVolume,
          transactionCount: snapshot.transactionCount,
          volumeGrowth: growth.volumeGrowth.toFixed(2),
          balanceGrowth: growth.balanceGrowth.toFixed(2),
          year: new Date().getFullYear(),
        },
      });
    } else {
      // Fallback HTML
      await sgMail.send({
        from,
        to: email,
        subject: `Daily Financial Summary - ${snapshot.snapshotDate}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;padding:20px;">
            <h2 style="color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px;">Daily Financial Summary</h2>
            <p><strong>Date:</strong> ${snapshot.snapshotDate}</p>
            
            <div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:20px 0;">
              <h3 style="margin-top:0;color:#2980b9;">Balances</h3>
              <table style="width:100%;">
                <tr><td>Total Balance:</td><td style="text-align:right;"><strong>${snapshot.totalBalance}</strong></td></tr>
                <tr><td style="padding-left:15px;color:#666;">- Main Balance:</td><td style="text-align:right;color:#666;">${snapshot.totalMainBalance}</td></tr>
                <tr><td style="padding-left:15px;color:#666;">- Vault Balance:</td><td style="text-align:right;color:#666;">${snapshot.totalVaultBalance}</td></tr>
                <tr><td>Balance Growth (DoD):</td><td style="text-align:right;color:${growth.balanceGrowth >= 0 ? "#27ae60" : "#c0392b"};">${growth.balanceGrowth.toFixed(2)}%</td></tr>
              </table>
            </div>

            <div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:20px 0;">
              <h3 style="margin-top:0;color:#2980b9;">Volume</h3>
              <table style="width:100%;">
                <tr><td>Daily Volume:</td><td style="text-align:right;"><strong>${snapshot.dailyVolume}</strong></td></tr>
                <tr><td>Transaction Count:</td><td style="text-align:right;">${snapshot.transactionCount}</td></tr>
                <tr><td>Volume Growth (DoD):</td><td style="text-align:right;color:${growth.volumeGrowth >= 0 ? "#27ae60" : "#c0392b"};">${growth.volumeGrowth.toFixed(2)}%</td></tr>
              </table>
            </div>

            <p style="color:#999;font-size:12px;margin-top:30px;text-align:center;">
              &copy; ${new Date().getFullYear()} Mobile Money. This is an automated management report.
            </p>
          </div>
        `,
      });
    }
  }

  async sendVulnerabilityReport(
    email: string,
    report: VulnerabilityReport,
  ): Promise<void> {
    const templateId = process.env.SENDGRID_VULNERABILITY_REPORT_TEMPLATE_ID;
    const from = process.env.EMAIL_FROM || '"Mobile Money" <no-reply@mobilemoney.com>';

    if (templateId) {
      await this.sendEmail({
        to: email,
        templateId,
        dynamicTemplateData: {
          ...report,
          reportDate: new Date().toLocaleDateString(),
          year: new Date().getFullYear(),
        },
      });
    } else {
      // Fallback HTML
      await sgMail.send({
        from,
        to: email,
        subject: `Weekly Security Vulnerability Report - ${new Date().toLocaleDateString()}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;padding:20px;">
            <h2 style="color:#2c3e50;border-bottom:2px solid #e74c3c;padding-bottom:10px;">Security Vulnerability Report</h2>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            
            <div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:20px 0;">
              <h3 style="margin-top:0;color:#c0392b;">Summary</h3>
              <table style="width:100%; font-size: 16px;">
                <tr><td style="padding: 4px 0;">Total Vulnerabilities:</td><td style="text-align:right;"><strong>${report.total}</strong></td></tr>
                <tr><td style="color:#c0392b; padding: 4px 0;">Critical:</td><td style="text-align:right;color:#c0392b;"><strong>${report.critical}</strong></td></tr>
                <tr><td style="color:#e67e22; padding: 4px 0;">High:</td><td style="text-align:right;color:#e67e22;"><strong>${report.high}</strong></td></tr>
                <tr><td style="color:#f39c12; padding: 4px 0;">Moderate:</td><td style="text-align:right;color:#f39c12;"><strong>${report.moderate}</strong></td></tr>
                <tr><td style="color:#27ae60; padding: 4px 0;">Low:</td><td style="text-align:right;color:#27ae60;"><strong>${report.low}</strong></td></tr>
              </table>
            </div>
            <p style="color:#999;font-size:12px;margin-top:30px;text-align:center;">
              &copy; ${new Date().getFullYear()} Mobile Money. Automated Security Audit.
            </p>
          </div>
        `,
      });
    }
  }
}

export const emailService = new EmailService();
