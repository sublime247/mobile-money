import { pool } from "../config/database";
import { LedgerService } from "../services/ledgerService";
import { EmailService } from "../services/email";
import logger from "../utils/logger";
import PDFDocument from "pdfkit";

const ledgerService = new LedgerService();
const emailService = new EmailService();

export interface LedgerBalanceCheck {
  total_debits: number;
  total_credits: number;
  difference: number;
  is_balanced: boolean;
}

export interface TrialBalance {
  account_code: string;
  account_name: string;
  account_type: string;
  debit_balance: number;
  credit_balance: number;
}

export async function generateReconciliationReportPDF(
  merchantName: string,
  month: number,
  year: number,
  ledgerCheck: LedgerBalanceCheck,
  trialBalance: TrialBalance[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => reject(err));

      // Header - Branding
      doc
        .fillColor("#2c3e50")
        .fontSize(20)
        .text("MOBILE MONEY RECONCILIATION REPORT", 50, 45)
        .fontSize(10)
        .fillColor("#7f8c8d")
        .text(`Merchant: ${merchantName}`, 50, 70)
        .text(`Period: ${new Date(year, month - 1).toLocaleString("default", { month: "long" })} ${year}`, 50, 85)
        .text("System Reconciliation Service", 200, 45, { align: "right" })
        .moveDown();

      // Horizontal Line
      doc.moveTo(50, 110).lineTo(550, 110).strokeColor("#bdc3c7").stroke();

      // Ledger Balance Status
      doc
        .fontSize(14)
        .fillColor("#2c3e50")
        .text("Ledger Balance Summary", 50, 130)
        .moveDown(0.5);

      doc
        .fontSize(10)
        .fillColor("#34495e")
        .text(`Total Debits: ${ledgerCheck.total_debits.toFixed(2)} USD`, 50, 160)
        .text(`Total Credits: ${ledgerCheck.total_credits.toFixed(2)} USD`, 50, 175)
        .text(`Difference: ${ledgerCheck.difference.toFixed(2)} USD`, 50, 190);

      const balanceText = ledgerCheck.is_balanced 
        ? "STATUS: LEDGER IS BALANCED" 
        : "STATUS: LEDGER IS OUT OF BALANCE";
      const balanceColor = ledgerCheck.is_balanced ? "#27ae60" : "#c0392b";

      doc
        .fontSize(12)
        .fillColor(balanceColor)
        .text(balanceText, 50, 215, { underline: true })
        .moveDown(1.5);

      // Trial Balance Table
      doc
        .fontSize(14)
        .fillColor("#2c3e50")
        .text("Trial Balance Details", 50, 250)
        .moveDown();

      let y = 280;
      doc.fontSize(10).fillColor("#34495e");
      doc.font("Helvetica-Bold");
      doc.text("Account Code", 50, y);
      doc.text("Account Name", 150, y);
      doc.text("Type", 300, y);
      doc.text("Debits", 400, y);
      doc.text("Credits", 480, y);
      doc.font("Helvetica");
      y += 20;
      doc.moveTo(50, y - 5).lineTo(550, y - 5).strokeColor("#ecf0f1").stroke();

      trialBalance.forEach(row => {
        if (y > 700) {
          doc.addPage();
          y = 50;
        }
        doc.text(row.account_code || "", 50, y);
        doc.text(row.account_name || "", 150, y);
        doc.text(row.account_type || "", 300, y);
        doc.text(row.debit_balance.toFixed(2), 400, y);
        doc.text(row.credit_balance.toFixed(2), 480, y);
        y += 20;
      });

      // Footer
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor("#95a5a6")
          .text(
            "Confidential - Internal Merchant Financial Report. Generated automatically by Mobile Money.",
            50,
            750,
            { align: "center", width: 500 }
          );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export async function runMonthlyReconciliationReportJob() {
  // Determine previous month
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();

  logger.info(`Starting monthly reconciliation report job for ${month}/${year}`);

  try {
    // 1. Fetch active merchants
    const merchantsResult = await pool.query(
      "SELECT id, name, email FROM merchants WHERE status = 'active'"
    );

    if (merchantsResult.rows.length === 0) {
      logger.info("No active merchants found to send monthly reports to.");
      return;
    }

    // 2. Fetch double-entry ledger details
    const ledgerCheck = await ledgerService.checkLedgerBalance();
    const trialBalance = await ledgerService.getTrialBalance();

    for (const merchant of merchantsResult.rows) {
      try {
        if (!merchant.email) continue;

        // 3. Generate PDF report
        const pdfBuffer = await generateReconciliationReportPDF(
          merchant.name,
          month,
          year,
          ledgerCheck,
          trialBalance
        );

        // 4. Dispatch Email with attachment
        await emailService.sendEmail({
          to: merchant.email,
          templateId: process.env.SENDGRID_RECONCILIATION_REPORT_TEMPLATE_ID || "d-generic-reconciliation-report",
          dynamicTemplateData: {
            month: new Date(year, month - 1).toLocaleString("default", { month: "long" }),
            year: year,
            merchantName: merchant.name,
            isBalanced: ledgerCheck.is_balanced,
          },
          attachments: [
            {
              content: pdfBuffer.toString("base64"),
              filename: `Reconciliation_Report_${month}_${year}.pdf`,
              type: "application/pdf",
              disposition: "attachment",
            },
          ],
        });

        logger.info(`Successfully sent monthly reconciliation report to ${merchant.name} (${merchant.email})`);
      } catch (merchantErr) {
        logger.error(merchantErr, `Failed to send reconciliation report to merchant ${merchant.id}`);
      }
    }
  } catch (err) {
    logger.error(err, "Monthly reconciliation report job failed");
  }
}
