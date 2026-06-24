import PDFDocument from "pdfkit";
import { Transaction } from "../models/transaction";
import { maskPhoneNumber, maskStellarAddress } from "../utils/masking";
import { CurrencyFormatter } from "../utils/currency";

export interface TransactionPdfOptions {
  title?: string;
  merchantName?: string;
  merchantUrl?: string;
  merchantAddress?: string;
  merchantDescription?: string;
}

export async function generateTransactionPdfBuffer(
  transaction: Transaction,
  options: TransactionPdfOptions = {},
): Promise<Buffer> {
  const merchantName = options.merchantName || process.env.ORG_NAME || "Mobile Money";
  const merchantUrl = options.merchantUrl || process.env.ORG_URL || "";
  const merchantAddress = options.merchantAddress || process.env.ORG_ADDRESS || "";
  const merchantDescription = options.merchantDescription || process.env.ORG_DESCRIPTION || "Mobile money to Stellar";
  const title = options.title || "Transaction Receipt";
  const idLabel = title.toLowerCase().includes("invoice") ? "Invoice ID" : "Receipt ID";

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => reject(err));

      // Header with merchant branding
      doc
        .fillColor("#333")
        .fontSize(18)
        .text(merchantName, { align: "left" });

      if (merchantUrl) {
        doc
          .fontSize(9)
          .fillColor("#3498db")
          .text(merchantUrl, { align: "left", link: merchantUrl });
      }

      if (merchantAddress) {
        doc
          .fontSize(9)
          .fillColor("#666")
          .text(merchantAddress, { align: "left" });
      }

      if (merchantDescription) {
        doc
          .fontSize(10)
          .fillColor("#666")
          .text(merchantDescription, { align: "left" })
          .moveDown(0.5);
      } else {
        doc.moveDown(0.5);
      }

      doc
        .fontSize(16)
        .fillColor("#000")
        .text(title, { align: "left" });

      doc.moveDown(0.25);
      doc
        .fontSize(10)
        .fillColor("#666")
        .text(`${idLabel}: ${transaction.referenceNumber}`);
      doc
        .fontSize(10)
        .fillColor("#666")
        .text(`Transaction ID: ${transaction.id}`);
      doc.moveDown(0.5);

      // Divider line
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#eeeeee").stroke();
      doc.moveDown(0.5);

      // Main details
      const leftX = 50;
      const rightX = 400;

      doc.fillColor("#000").fontSize(12).text("Details", leftX);

      doc.fontSize(10).text(`Type: ${transaction.type}`, leftX, doc.y + 6);
      doc.text(`Provider: ${transaction.provider}`, leftX);
      doc.text(`Phone: ${maskPhoneNumber(transaction.phoneNumber)}`, leftX);
      if (transaction.stellarAddress)
        doc.text(`Stellar: ${maskStellarAddress(transaction.stellarAddress)}`, leftX);

      const metadata = (transaction as any).metadata as Record<string, any> | undefined;
      const txHash =
        metadata?.transactionHash ||
        metadata?.stellarTransactionId ||
        (transaction as any).transactionHash ||
        (transaction as any).stellarTransactionId;

      if (txHash) {
        const network =
          process.env.STELLAR_NETWORK === "mainnet" ||
          process.env.STELLAR_NETWORK === "public"
            ? "public"
            : "testnet";
        const stellarExpertUrl = `https://stellar.expert/explorer/${network}/tx/${txHash}`;

        doc.moveDown(0.2);
        doc
          .fontSize(10)
          .fillColor("#3498db")
          .text(`View Transaction on StellarExpert`, leftX, doc.y, {
            link: stellarExpertUrl,
            underline: true,
          })
          .fillColor("#000");
      }

      let amountStr = transaction.amount;
      try {
        const numericAmount = parseFloat(transaction.amount);
        if (!isNaN(numericAmount)) {
          amountStr = CurrencyFormatter.format(
            numericAmount,
            transaction.currency || "USD"
          );
        }
      } catch (err) {
        console.warn("[pdfReceipt] Failed to format amount with CurrencyFormatter:", err);
      }

      doc.fontSize(12).text(`Amount`, rightX, 140, { continued: false });
      doc.fontSize(14).text(`${amountStr}`, rightX, 158, { align: "right" });

      doc.moveDown(1.5);

      doc
        .fontSize(10)
        .fillColor("#333")
        .text(`Status: ${transaction.status}`, leftX);
      doc.text(`Created: ${new Date(transaction.createdAt).toLocaleString()}`, leftX);

      if (transaction.notes) {
        doc.moveDown(0.5);
        doc.fontSize(11).fillColor("#000").text("Notes", leftX);
        doc
          .fontSize(10)
          .fillColor("#333")
          .text(transaction.notes || "", { width: 500 });
      }

      doc.moveDown(2);
      doc
        .fontSize(9)
        .fillColor("#999")
        .text(`Generated at ${new Date().toLocaleString()}`, {
          align: "center",
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
