import { ProviderReconService } from "../services/providerReconService";
import { reconcileTelecomAccountsAgainstLedger } from "../services/accounting/ledger";
import {
  mpesaReconciliationService,
  parseMpesaStatement,
} from "../services/mobilemoney/mpesaReconciliation";
import logger from "../utils/logger";
import nodemailer from "nodemailer";

/**
 * Daily reconciliation job.
 * Runs reconciliation for all configured providers for the previous day,
 * matches total values against internal double-entry journals, and emails reports to finance admins.
 */
export async function runReconciliationJob() {
  logger.info("[reconciliation-job] Starting daily reconciliation");

  const reconService = new ProviderReconService();

  // Get yesterday's date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // List of providers to reconcile
  const providers = ["MTN", "AIRTEL", "STELLAR", "MPESA"];
  const discrepanciesFound: string[] = [];

  for (const provider of providers) {
    try {
      logger.info(`[reconciliation-job] Processing provider: ${provider}`);

      // 1. Fetch the report
      const csvBuffer = await reconService.fetchProviderReport(
        provider,
        yesterday,
      );

      if (!csvBuffer) {
        logger.warn(
          `[reconciliation-job] No report found for ${provider} on ${yesterday.toDateString()}. Skipping.`,
        );
        continue;
      }

      // 2. Run reconciliation against provider files
      if (provider === "MPESA") {
        const statementRecords = await parseMpesaStatement(csvBuffer);
        const result = await mpesaReconciliationService.reconcile({
          statementRecords,
          reportDate: yesterday,
          fileName: `mpesa_b2c_recon_${yesterday.toISOString().split("T")[0]}.csv`,
        });
        if (result.summary.totalDiscrepancies > 0) {
          discrepanciesFound.push(
            `Provider MPESA: ${result.summary.totalDiscrepancies} discrepancies detected (Amount: ${result.summary.amountDiscrepancies}, Missing callbacks: ${result.summary.missingCallbacks}, Duplicates: ${result.summary.duplicateDisbursements})`,
          );
        }
      } else {
        await reconService.runReconciliation(
          provider,
          yesterday,
          csvBuffer,
          `${provider}_recon_${yesterday.toISOString().split("T")[0]}.csv`,
        );
      }

      // 3. Match total values against internal double-entry journals
      const ledgerMatch = await reconcileTelecomAccountsAgainstLedger(provider, yesterday);
      if (!ledgerMatch.matched) {
        discrepanciesFound.push(
          `Provider ${provider}: Discrepancy detected. External total: ${ledgerMatch.externalTotal}, Internal ledger total: ${ledgerMatch.internalTotal}`
        );
      }
    } catch (error) {
      logger.error(error, `[reconciliation-job] Failed for ${provider}`);
      discrepanciesFound.push(`Provider ${provider}: Error during reconciliation - ${(error as Error).message}`);
    }
  }

  // 4. E-mail reports to finance admins
  await sendFinanceAdminReport(yesterday, discrepanciesFound);

  logger.info("[reconciliation-job] Daily reconciliation job completed");
}

async function sendFinanceAdminReport(date: Date, discrepancies: string[]): Promise<void> {
  const adminEmail = process.env.FINANCE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "finance-admins@example.com";
  const smtpHost = process.env.SMTP_HOST || "localhost";
  const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || "",
    } : undefined,
  });

  const dateStr = date.toISOString().split("T")[0];
  const statusText = discrepancies.length === 0 ? "SUCCESS: All balances matched" : `WARNING: ${discrepancies.length} discrepancy(ies) found`;

  const body = `
Daily Telecom Balance Reconciliation Report - ${dateStr}

Status: ${statusText}

Details:
${discrepancies.length === 0 ? "No discrepancies detected." : discrepancies.join("\n")}

---
Mobile Money ↔ Stellar Bridge Automated Reconciliation Service
  `.trim();

  try {
    if (process.env.NODE_ENV === "test" || !process.env.SMTP_HOST) {
      logger.info({ adminEmail, discrepancies }, "[reconciliation-job] Email report generated (mocked/test mode)");
      return;
    }

    await transporter.sendMail({
      from: process.env.SMTP_FROM || "reconciliation@driptide.local",
      to: adminEmail,
      subject: `[Reconciliation Report] ${dateStr} - ${statusText}`,
      text: body,
    });
    logger.info(`[reconciliation-job] Finance reconciliation report emailed to ${adminEmail}`);
  } catch (err) {
    logger.error(err, "[reconciliation-job] Failed to email finance admin report");
  }
}
