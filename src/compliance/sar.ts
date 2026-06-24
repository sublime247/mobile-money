import logger from "../utils/logger";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { create as createXml } from "xmlbuilder2";
import { amlService, AMLAlert } from "../services/aml";
import { TransactionModel, Transaction } from "../models/transaction";
import { getUserById, User } from "../services/userService";
import { uploadToS3, UploadResult } from "../services/s3Upload";
import { DB_ENCRYPTION_KEY } from "../config/env";

/**
 * Data needed for SAR generation
 */
interface SARData {
  user: User;
  transactions: Transaction[];
  alerts: AMLAlert[];
  alertContext?: AMLAlert;
  summary: {
    totalTransactions: number;
    totalAmount: number;
    riskFlags: string[];
    reportDate: Date;
    reportId: string;
  };
}

/**
 * Collates transaction history and AML alerts for a user.
 */
async function fetchSARData(userId: string, alertId?: string): Promise<SARData> {
  const user = await getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const transactionModel = new TransactionModel();
  // Fetch recent completed transactions (last 90 days for regulatory compliance)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const transactions = await transactionModel.findCompletedByUserSince(userId, ninetyDaysAgo);

  // Fetch recent alerts
  const alerts = amlService.getAlerts({ userId }).filter(a => new Date(a.createdAt) >= ninetyDaysAgo);
  
  const alertContext = alertId ? alerts.find(a => a.id === alertId) : undefined;

  const totalAmount = transactions.reduce((sum, tx) => sum + Number(tx.amount), 0);
  const riskFlags = Array.from(new Set(alerts.flatMap(a => a.ruleHits.map(h => h.rule))));

  return {
    user,
    transactions,
    alerts,
    alertContext,
    summary: {
      totalTransactions: transactions.length,
      totalAmount,
      riskFlags,
      reportDate: new Date(),
      reportId: crypto.randomBytes(8).toString("hex").toUpperCase(),
    },
  };
}

/**
 * Generates an XML report buffer according to generic FinCEN-like standards.
 */
function generateXMLBuffer(data: SARData): Buffer {
  const obj = {
    SuspiciousActivityReport: {
      Header: {
        ReportID: data.summary.reportId,
        Date: data.summary.reportDate.toISOString(),
        Type: "SAR-X",
      },
      Filer: {
        OrganizationName: "Mobile Money Platform",
        TIN: "99-9999999", // Mock TIN
      },
      Subject: {
        UserID: data.user.id,
        PhoneNumber: data.user.phone_number,
        KYCLevel: data.user.kyc_level,
      },
      Activity: {
        TotalAmount: data.summary.totalAmount,
        Currency: "XAF",
        TransactionCount: data.summary.totalTransactions,
        RiskFlags: {
          Flag: data.summary.riskFlags,
        },
        Narrative: data.alertContext 
          ? `Alert triggered by rules: ${data.alertContext.reasons.join(", ")}.`
          : "General suspicious activity review based on transaction patterns.",
      },
      Transactions: {
        Transaction: data.transactions.slice(0, 100).map(tx => ({
          ID: tx.id,
          Date: tx.createdAt.toISOString(),
          Amount: tx.amount,
          Type: tx.type,
          Reference: tx.referenceNumber,
        })),
      }
    }
  };

  const xml = createXml(obj).end({ prettyPrint: true });
  return Buffer.from(xml);
}

/**
 * Generates a professional PDF report buffer using PDFKit.
 */
async function generatePDFBuffer(data: SARData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    // Logo/Header
    doc.fillColor("#2c3e50").fontSize(20).text("MOBILE MONEY PLATFORM", { align: "left" });
    doc.fillColor("#7f8c8d").fontSize(10).text("Compliance and Regulatory Affairs", { align: "left" });
    doc.moveDown();
    
    doc.fillColor("#c0392b").fontSize(16).text("SUSPICIOUS ACTIVITY REPORT (SAR)", { align: "center", underline: true });
    doc.moveDown();

    // Report Info
    doc.fillColor("#000").fontSize(10);
    const top = doc.y;
    doc.text(`Report ID: ${data.summary.reportId}`, 50, top);
    doc.text(`Generated: ${data.summary.reportDate.toLocaleString()}`, 350, top);
    doc.moveDown(2);

    // Section 1: Subject Info
    doc.fillColor("#2980b9").fontSize(14).text("SECTION I: SUBJECT INFORMATION", { underline: true });
    doc.fillColor("#000").fontSize(11);
    doc.moveDown(0.5);
    doc.text(`User Account ID: ${data.user.id}`);
    doc.text(`Phone Number: ${data.user.phone_number}`);
    doc.text(`KYC Verification Level: ${data.user.kyc_level}`);
    doc.moveDown();

    // Section 2: Suspicious Activity Summary
    doc.fillColor("#2980b9").fontSize(14).text("SECTION II: ACTIVITY SUMMARY", { underline: true });
    doc.fillColor("#000").fontSize(11);
    doc.moveDown(0.5);
    doc.text(`Detection Period: Last 90 Days`);
    doc.text(`Total Transactions Evaluated: ${data.summary.totalTransactions}`);
    doc.text(`Aggregated Suspicious Volume: ${data.summary.totalAmount.toLocaleString()} XAF`);
    doc.moveDown(0.5);
    
    doc.text("Identified Risk Patterns:");
    doc.font("Helvetica");
    if (data.summary.riskFlags.length > 0) {
      data.summary.riskFlags.forEach(flag => {
        doc.text(`  • ${flag.replace(/_/g, " ").toUpperCase()}`);
      });
    } else {
      doc.text("  • General transaction pattern anomaly");
    }
    doc.moveDown();

    // Section 3: Narrative
    doc.fillColor("#2980b9").fontSize(14).text("SECTION III: NARRATIVE DESCRIPTION", { underline: true });
    doc.fillColor("#000").fontSize(11);
    doc.moveDown(0.5);
    const narrative = data.alertContext 
      ? `This report was automatically prepared following a high-severity AML alert (${data.alertContext.id}). The user exhibited patterns matching the following criteria: ${data.alertContext.reasons.join("; ")}.`
      : "This report was prepared for manual review based on suspicious transaction frequency and/or volume exceeding normal operational parameters for this user segment.";
    doc.text(narrative, { align: "justify" });
    doc.moveDown();

    // Section 4: Transaction Detail (Sample)
    doc.fillColor("#2980b9").fontSize(14).text("SECTION IV: TRANSACTION LOG (SAMPLED)", { underline: true });
    doc.moveDown(0.5);

    // Table Header
    const tableTop = doc.y;
    doc.fillColor("#34495e").fontSize(10).font("Helvetica-Bold");
    doc.text("DATE", 50, tableTop);
    doc.text("TYPE", 150, tableTop);
    doc.text("AMOUNT", 250, tableTop);
    doc.text("STATUS", 350, tableTop);
    doc.text("REFERENCE", 450, tableTop);
    
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
    
    let currentY = tableTop + 25;
    doc.fillColor("#000").font("Helvetica");
    data.transactions.slice(0, 25).forEach(tx => {
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
      }
      doc.text(tx.createdAt.toISOString().split("T")[0], 50, currentY);
      doc.text(tx.type.toUpperCase(), 150, currentY);
      doc.text(`${Number(tx.amount).toLocaleString()} XAF`, 250, currentY);
      doc.text(tx.status.toUpperCase(), 350, currentY);
      doc.text(tx.referenceNumber.substring(0, 12), 450, currentY);
      currentY += 20;
    });

    if (data.transactions.length > 25) {
      doc.fillColor("#7f8c8d").fontSize(9).text(`Note: Only showing first 25 of ${data.transactions.length} total transactions. Full history available in XML export.`, 50, currentY + 10);
    }

    // Footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor("#bdc3c7").text(
        `CONFIDENTIAL - INTERNAL COMPLIANCE USE ONLY - Page ${i + 1} of ${range.count}`,
        50,
        doc.page.height - 50,
        { align: "center" }
      );
    }

    doc.end();
  });
}

/**
 * Encrypts a buffer using AES-256-GCM.
 */
function encryptBuffer(buffer: Buffer): Buffer {
  const ALGORITHM = "aes-256-gcm";
  const IV_LENGTH = 12;

  const iv = crypto.randomBytes(IV_LENGTH);
  const secretKey = crypto.scryptSync(DB_ENCRYPTION_KEY, "sar-salt", 32);
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey, iv);

  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Uploads encrypted SAR to storage.
 */
async function storeSARFile(encryptedBuffer: Buffer, userId: string, type: "pdf" | "xml"): Promise<string> {
  const filename = `SAR_${userId}_${Date.now()}.${type}.enc`;
  
  const file = {
    buffer: encryptedBuffer,
    originalname: filename,
    mimetype: "application/octet-stream",
    size: encryptedBuffer.length,
    fieldname: "file",
    encoding: "7bit",
  } as Express.Multer.File;

  const result: UploadResult = await uploadToS3({
    userId,
    file,
    metadata: {
      reportType: "SAR",
      format: type,
      encrypted: "true",
      algorithm: "AES-256-GCM"
    }
  });

  if (!result.success || !result.fileUrl) {
    throw new Error(`Failed to store SAR ${type}: ${result.error || "Unknown error"}`);
  }

  return result.fileUrl;
}

/**
 * Main function to generate, encrypt, and store SAR reports in multiple formats.
 */
export async function generateSAR(userId: string, alertId?: string): Promise<{ pdfUrl: string, xmlUrl: string }> {
  try {
    // 1. Collate data
    const data = await fetchSARData(userId, alertId);

    // 2. Generate Reports
    const [pdfBuffer, xmlBuffer] = await Promise.all([
      generatePDFBuffer(data),
      Promise.resolve(generateXMLBuffer(data))
    ]);

    // 3. Encrypt and Store
    const [pdfUrl, xmlUrl] = await Promise.all([
      storeSARFile(encryptBuffer(pdfBuffer), userId, "pdf"),
      storeSARFile(encryptBuffer(xmlBuffer), userId, "xml")
    ]);

    console.log(`SAR reports generated for user ${userId}. PDF: ${pdfUrl}, XML: ${xmlUrl}`);
    return { pdfUrl, xmlUrl };
  } catch (error) {
    logger.error(`Error generating SAR for user ${userId}:`, error);
    throw error;
  }
}
