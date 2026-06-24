import crypto from "crypto";
import PDFDocument from "pdfkit";
import { uploadToS3 } from "./s3Upload";
import { Transaction } from "../models/transaction";
import { AMLAlert } from "./aml";
import { DB_ENCRYPTION_KEY } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export async function generateFlaggedTransactionComplianceReport(
  transaction: Transaction,
  alert: AMLAlert,
): Promise<{ pdfUrl: string }> {
  if (!transaction.userId) {
    throw new Error("Transaction is missing userId for compliance report generation");
  }

  const pdfBuffer = await generatePDFBuffer(transaction, alert);
  const encryptedBuffer = encryptBuffer(pdfBuffer);
  const pdfUrl = await storeCompliancePdf(
    encryptedBuffer,
    transaction.userId,
    transaction.id,
    alert.id,
  );

  return { pdfUrl };
}

async function generatePDFBuffer(
  transaction: Transaction,
  alert: AMLAlert,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    doc.fillColor("#2c3e50").fontSize(18).text("Mobile Money", { align: "center" });
    doc.moveDown(0.25);
    doc.fontSize(12).fillColor("#7f8c8d").text("Flagged Transaction Compliance Report", {
      align: "center",
    });
    doc.moveDown(1);

    doc.fillColor("#34495e").fontSize(12).text("Report Details", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");
    doc.text(`Transaction ID: ${transaction.id}`);
    doc.text(`Reference Number: ${transaction.referenceNumber}`);
    doc.text(`User ID: ${transaction.userId}`);
    doc.text(`Provider: ${transaction.provider}`);
    doc.text(`Transaction Type: ${transaction.type}`);
    doc.text(`Amount: ${transaction.amount}`);
    doc.text(`Status: ${transaction.status}`);
    doc.text(`Created At: ${new Date(transaction.createdAt).toLocaleString()}`);
    if (transaction.phoneNumber) {
      doc.text(`Phone Number: ${transaction.phoneNumber}`);
    }
    if (transaction.stellarAddress) {
      doc.text(`Stellar Address: ${transaction.stellarAddress}`);
    }

    if (transaction.notes) {
      doc.moveDown(0.5);
      doc.fillColor("#2c3e50").fontSize(12).text("Transaction Notes", { underline: true });
      doc.moveDown(0.25);
      doc.fontSize(10).fillColor("#000").text(transaction.notes, {
        width: 500,
        align: "left",
      });
    }

    doc.moveDown(1);
    doc.fillColor("#34495e").fontSize(12).text("AML Alert Summary", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");
    doc.text(`Alert ID: ${alert.id}`);
    doc.text(`Severity: ${alert.severity}`);
    doc.text(`Status: ${alert.status}`);
    doc.text(`Created At: ${new Date(alert.createdAt).toLocaleString()}`);
    doc.text(`Reasons: ${alert.reasons.join(", ")}`);
    doc.moveDown(0.25);

    if (alert.ruleHits && alert.ruleHits.length > 0) {
      doc.fillColor("#000").fontSize(10).text("Rule Hits:");
      alert.ruleHits.forEach((hit) => {
        const details = [`• ${hit.rule.replace(/_/g, " ").toUpperCase()}`];
        if (hit.message) {
          details.push(`: ${hit.message}`);
        }
        if (typeof hit.observed === "number") {
          details.push(`(observed ${hit.observed})`);
        }
        if (typeof hit.threshold === "number") {
          details.push(`threshold ${hit.threshold}`);
        }
        doc.text(details.join(" "), { indent: 10 });
      });
    }

    doc.moveDown(1);
    doc.fillColor("#34495e").fontSize(12).text("Compliance Narrative", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");

    const narrative = `A transaction was flagged for AML review. The system generated this report to capture the flagged transaction details, alert metadata, and any related compliance context for downstream review and audit.`;
    doc.text(narrative, { align: "justify", width: 500 });

    doc.moveDown(2);
    doc.fillColor("#999").fontSize(9).text(
      `Generated at ${new Date().toLocaleString()}`,
      { align: "center" },
    );

    const pageRange = doc.bufferedPageRange();
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor("#bdc3c7").text(
        `CONFIDENTIAL - COMPLIANCE INTERNAL USE ONLY - Page ${i + 1} of ${pageRange.count}`,
        50,
        doc.page.height - 50,
        { align: "center" },
      );
    }

    doc.end();
  });
}

function encryptBuffer(buffer: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const secretKey = crypto.scryptSync(DB_ENCRYPTION_KEY, "compliance-report-salt", 32);
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey, iv);

  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

async function storeCompliancePdf(
  encryptedBuffer: Buffer,
  userId: string,
  transactionId: string,
  alertId: string,
): Promise<string> {
  const filename = `COMPLIANCE_TX_${transactionId}_${alertId}_${Date.now()}.pdf.enc`;
  const file = {
    buffer: encryptedBuffer,
    originalname: filename,
    mimetype: "application/octet-stream",
    size: encryptedBuffer.length,
    fieldname: "file",
    encoding: "7bit",
  } as Express.Multer.File;

  const result = await uploadToS3({
    userId,
    file,
    metadata: {
      reportType: "compliance",
      source: "flagged_transaction",
      transactionId,
      alertId,
      encrypted: "true",
      algorithm: ALGORITHM,
    },
  });

  if (!result.success || !result.fileUrl) {
    throw new Error(`Failed to store compliance report PDF: ${result.error ?? "Unknown error"}`);
  }

  return result.fileUrl;
}
