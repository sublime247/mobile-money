import { Router, Request, Response } from "express";
import { pool } from "../config/database";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { decrypt } from "../utils/encryption";
import PDFDocument from "pdfkit";

export const statementsRoutes = Router();

interface StatementTransaction {
  id: string;
  referenceNumber: string;
  type: "deposit" | "withdraw";
  amount: string;
  currency: string;
  provider: string;
  status: string;
  createdAt: Date;
  notes?: string;
}

interface MonthlyStatement {
  user: {
    id: string;
    phoneNumber: string;
    kycLevel: string;
  };
  period: {
    month: number;
    year: number;
    startDate: string;
    endDate: string;
  };
  summary: {
    openingBalance: number;
    totalDeposits: number;
    totalWithdrawals: number;
    closingBalance: number;
    transactionCount: number;
  };
  transactions: StatementTransaction[];
}

/**
 * Generate Monthly Account Statement PDF
 * GET /api/statements/monthly/:year/:month
 */
statementsRoutes.get(
  "/monthly/:year/:month",
  TimeoutPresets.medium,
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { year, month } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const yearNum = parseInt(year, 10);
      const monthNum = parseInt(month, 10);

      if (
        isNaN(yearNum) ||
        isNaN(monthNum) ||
        yearNum < 2020 ||
        yearNum > new Date().getFullYear() + 1 ||
        monthNum < 1 ||
        monthNum > 12
      ) {
        return res.status(400).json({ error: "Invalid year or month" });
      }

      const statement = await generateMonthlyStatement(userId, yearNum, monthNum);

      if (!statement) {
        return res.status(404).json({ error: "No data found for the specified period" });
      }

      const pdfBuffer = await generateStatementPDF(statement);

      const filename = `statement-${year}-${month.padStart(2, "0")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", pdfBuffer.length);

      res.send(pdfBuffer);
    } catch (error) {
      console.error("Error generating monthly statement:", error);
      res.status(500).json({ error: "Failed to generate statement" });
    }
  }
);

async function generateMonthlyStatement(
  userId: string,
  year: number,
  month: number
): Promise<MonthlyStatement | null> {
  const client = await pool.connect();

  try {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    const userResult = await client.query(
      "SELECT id, phone_number, kyc_level FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return null;
    }

    const user = userResult.rows[0];

    const transactionsResult = await client.query(
      `
      SELECT
        id,
        reference_number as "referenceNumber",
        type,
        amount::text as amount,
        COALESCE(currency, 'USD') as currency,
        provider,
        status,
        notes,
        created_at as "createdAt"
      FROM transactions
      WHERE user_id = $1
        AND created_at >= $2
        AND created_at <= $3
        AND status = 'completed'
      ORDER BY created_at ASC
    `,
      [userId, startDate, endDate]
    );

    const openingBalanceResult = await client.query(
      `
      SELECT
        COALESCE(
          SUM(CASE WHEN type = 'deposit' THEN amount::numeric ELSE -amount::numeric END),
          0
        ) as opening_balance
      FROM transactions
      WHERE user_id = $1
        AND created_at < $2
        AND status = 'completed'
    `,
      [userId, startDate]
    );

    const openingBalance = parseFloat(openingBalanceResult.rows[0]?.opening_balance || "0");

    let totalDeposits = 0;
    let totalWithdrawals = 0;

    const transactions: StatementTransaction[] = transactionsResult.rows.map((row) => {
      const amount = parseFloat(row.amount);

      if (row.type === "deposit") {
        totalDeposits += amount;
      } else {
        totalWithdrawals += amount;
      }

      return {
        id: row.id,
        referenceNumber: row.referenceNumber,
        type: row.type,
        amount: row.amount,
        currency: row.currency,
        provider: row.provider,
        status: row.status,
        createdAt: row.createdAt,
        notes: row.notes ? decrypt(row.notes) : undefined,
      };
    });

    const closingBalance = openingBalance + totalDeposits - totalWithdrawals;

    return {
      user: {
        id: user.id,
        phoneNumber: decrypt(user.phone_number),
        kycLevel: user.kyc_level,
      },
      period: {
        month,
        year,
        startDate: startDate.toISOString().split("T")[0],
        endDate: endDate.toISOString().split("T")[0],
      },
      summary: {
        openingBalance,
        totalDeposits,
        totalWithdrawals,
        closingBalance,
        transactionCount: transactions.length,
      },
      transactions,
    };
  } finally {
    client.release();
  }
}

function generateStatementPDF(statement: MonthlyStatement): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => reject(err));

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const margin = 50;

      doc.font("Helvetica");

      doc
        .fontSize(20)
        .font("Helvetica-Bold")
        .text("Mobile Money Services", { align: "center" });

      doc
        .moveDown(0.3)
        .fontSize(14)
        .text("Monthly Account Statement", { align: "center" });

      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      const periodText = `${monthNames[statement.period.month - 1]} ${statement.period.year}`;

      doc
        .moveDown(0.8)
        .fontSize(10)
        .font("Helvetica")
        .text(`Statement Period: ${periodText}`, { continued: false })
        .text(`Account: ${statement.user.phoneNumber}`)
        .text(`KYC Level: ${statement.user.kycLevel.toUpperCase()}`)
        .text(`Generated: ${new Date().toLocaleDateString()}`);

      const formatCurrency = (amount: number) =>
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
        }).format(amount);

      const summaryTop = doc.y;
      doc
        .fontSize(12)
        .font("Helvetica-Bold")
        .text("Account Summary", { continued: false });
      doc.moveDown(0.2);
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(`Opening Balance:    ${formatCurrency(statement.summary.openingBalance)}`)
        .text(`Total Deposits:     ${formatCurrency(statement.summary.totalDeposits)}`)
        .text(`Total Withdrawals:  (${formatCurrency(statement.summary.totalWithdrawals)})`)
        .font("Helvetica-Bold")
        .text(`Closing Balance:    ${formatCurrency(statement.summary.closingBalance)}`);

      const summaryBoxY = summaryTop - 10;
      const summaryBoxHeight = doc.y - summaryBoxY + 10;
      doc
        .moveTo(margin, summaryBoxY)
        .lineTo(pageWidth - margin, summaryBoxY)
        .lineTo(pageWidth - margin, summaryBoxY + summaryBoxHeight)
        .lineTo(margin, summaryBoxY + summaryBoxHeight)
        .closePath()
        .stroke();

      doc.moveDown(0.5);

      const tableTop = doc.y;
      const colWidths = [58, 73, 53, 59, 74, 74, 104];
      const tableWidth = colWidths.reduce((a, b) => a + b, 0);
      const tableStartX = margin;

      const headerLabels = [
        "Date",
        "Reference",
        "Type",
        "Provider",
        "Deposits",
        "Withdrawals",
        "Notes",
      ];

      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#f0f0f0")
        .rect(tableStartX, tableTop, tableWidth, 18)
        .fill();

      let x = tableStartX;
      headerLabels.forEach((label, i) => {
        doc.fillColor("#000000").text(label, x + 2, tableTop + 5, {
          width: colWidths[i] - 4,
          align: i >= 4 ? "right" : "left",
        });
        x += colWidths[i];
      });

      doc.y = tableTop + 18;

      const rows = statement.transactions.map((tx) => [
        new Date(tx.createdAt).toLocaleDateString(),
        tx.referenceNumber,
        tx.type.charAt(0).toUpperCase() + tx.type.slice(1),
        tx.provider,
        tx.type === "deposit" ? formatCurrency(parseFloat(tx.amount)) : "",
        tx.type === "withdraw" ? formatCurrency(parseFloat(tx.amount)) : "",
        tx.notes || "",
      ]);

      rows.forEach((row, rowIndex) => {
        if (doc.y > pageHeight - 60) {
          doc.addPage();
          doc.moveDown(0.5);
        }

        const rowTop = doc.y;
        const rowHeight = Math.max(14, row.reduce((max, cell, i) => {
          const lines = doc.heightOfString(cell, { width: colWidths[i] - 4 });
          return Math.max(max, Math.ceil(lines) + 8);
        }, 0));

        doc
          .fillColor(rowIndex % 2 === 0 ? "#ffffff" : "#fafafa")
          .rect(tableStartX, rowTop, tableWidth, rowHeight)
          .fill();

        x = tableStartX;
        row.forEach((cell, i) => {
          doc.fillColor("#000000").text(cell, x + 2, rowTop + 4, {
            width: colWidths[i] - 4,
            align: i >= 4 ? "right" : "left",
          });
          x += colWidths[i];
        });

        doc.y = rowTop + rowHeight;
        doc
          .strokeColor("#cccccc")
          .lineWidth(0.5)
          .moveTo(tableStartX, rowTop + rowHeight)
          .lineTo(tableStartX + tableWidth, rowTop + rowHeight)
          .stroke();
      });

      if (rows.length === 0) {
        doc
          .fontSize(10)
          .font("Helvetica")
          .text("No transactions found for this period.", margin, tableTop + 10);
      }

      doc.font("Helvetica").fontSize(8).fillColor("#000000");

      const footerY = pageHeight - margin - 30;
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.text(
          "This statement is generated electronically and is valid without signature.",
          margin,
          footerY,
          { align: "center", width: pageWidth - 2 * margin }
        );
        doc.text(
          "For inquiries, please contact customer support.",
          margin,
          footerY + 10,
          { align: "center", width: pageWidth - 2 * margin }
        );
        doc.text(`Page ${i + 1}`, pageWidth - margin - 20, footerY + 10, {
          align: "right",
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
