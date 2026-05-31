import { Router, Request, Response } from "express";
import { pool } from "../config/database";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { decrypt } from "../utils/encryption";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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

      // Validate year and month parameters
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

      // Generate statement data
      const statement = await generateMonthlyStatement(
        userId,
        yearNum,
        monthNum,
      );

      if (!statement) {
        return res
          .status(404)
          .json({ error: "No data found for the specified period" });
      }

      // Generate PDF
      const pdfBuffer = await generateStatementPDF(statement);

      // Set response headers for PDF download
      const filename = `statement-${year}-${month.padStart(2, "0")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Content-Length", pdfBuffer.length);

      // Stream PDF to client
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Error generating monthly statement:", error);
      res.status(500).json({ error: "Failed to generate statement" });
    }
  },
);

/**
 * Gather chronologically ordered transactions for a user in a specific month
 */
async function generateMonthlyStatement(
  userId: string,
  year: number,
  month: number,
): Promise<MonthlyStatement | null> {
  const client = await pool.connect();

  try {
    // Calculate date range for the month
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    // Get user information
    const userResult = await client.query(
      "SELECT id, phone_number, kyc_level FROM users WHERE id = $1",
      [userId],
    );

    if (userResult.rows.length === 0) {
      return null;
    }

    const user = userResult.rows[0];

    // Get transactions for the month, ordered chronologically
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
      [userId, startDate, endDate],
    );

    // Calculate opening balance (sum of all completed transactions before this month)
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
      [userId, startDate],
    );

    const openingBalance = parseFloat(
      openingBalanceResult.rows[0]?.opening_balance || "0",
    );

    // Calculate monthly totals
    let totalDeposits = 0;
    let totalWithdrawals = 0;

    const transactions: StatementTransaction[] = transactionsResult.rows.map(
      (row) => {
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
      },
    );

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

/**
 * Generate professional PDF statement with standard accounting header/footer
 */
async function generateStatementPDF(
  statement: MonthlyStatement,
): Promise<Buffer> {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;

  // Company header
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("Mobile Money Services", pageWidth / 2, 20, { align: "center" });

  doc.setFontSize(16);
  doc.text("Monthly Account Statement", pageWidth / 2, 30, { align: "center" });

  // Statement period and account info
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const periodText = `${monthNames[statement.period.month - 1]} ${statement.period.year}`;
  doc.text(`Statement Period: ${periodText}`, 20, 45);
  doc.text(`Account: ${statement.user.phoneNumber}`, 20, 52);
  doc.text(`KYC Level: ${statement.user.kycLevel.toUpperCase()}`, 20, 59);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 20, 66);

  // Account summary box
  doc.setDrawColor(0, 0, 0);
  doc.rect(20, 75, pageWidth - 40, 35);

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text("Account Summary", 25, 85);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount);

  doc.text(`Opening Balance:`, 25, 95);
  doc.text(formatCurrency(statement.summary.openingBalance), 120, 95);

  doc.text(`Total Deposits:`, 25, 102);
  doc.text(formatCurrency(statement.summary.totalDeposits), 120, 102);

  doc.text(`Total Withdrawals:`, 25, 109);
  doc.text(`(${formatCurrency(statement.summary.totalWithdrawals)})`, 120, 109);

  doc.setFont("helvetica", "bold");
  doc.text(`Closing Balance:`, 25, 116);
  doc.text(formatCurrency(statement.summary.closingBalance), 120, 116);

  // Transaction details table
  if (statement.transactions.length > 0) {
    const tableData = statement.transactions.map((tx) => [
      new Date(tx.createdAt).toLocaleDateString(),
      tx.referenceNumber,
      tx.type.charAt(0).toUpperCase() + tx.type.slice(1),
      tx.provider,
      tx.type === "deposit" ? formatCurrency(parseFloat(tx.amount)) : "",
      tx.type === "withdraw" ? formatCurrency(parseFloat(tx.amount)) : "",
      tx.notes || "",
    ]);

    autoTable(doc, {
      startY: 125,
      head: [
        [
          "Date",
          "Reference",
          "Type",
          "Provider",
          "Deposits",
          "Withdrawals",
          "Notes",
        ],
      ],
      body: tableData,
      styles: {
        fontSize: 8,
        cellPadding: 2,
      },
      headStyles: {
        fillColor: [240, 240, 240],
        textColor: [0, 0, 0],
        fontStyle: "bold",
      },
      columnStyles: {
        0: { cellWidth: 20 }, // Date
        1: { cellWidth: 25 }, // Reference
        2: { cellWidth: 18 }, // Type
        3: { cellWidth: 20 }, // Provider
        4: { cellWidth: 25, halign: "right" }, // Deposits
        5: { cellWidth: 25, halign: "right" }, // Withdrawals
        6: { cellWidth: 35 }, // Notes
      },
      margin: { left: 20, right: 20 },
    });
  } else {
    doc.setFontSize(10);
    doc.text("No transactions found for this period.", 20, 135);
  }

  // Footer with legal disclaimer
  const footerY = pageHeight - 30;
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text(
    "This statement is generated electronically and is valid without signature.",
    pageWidth / 2,
    footerY,
    { align: "center" },
  );
  doc.text(
    "For inquiries, please contact customer support.",
    pageWidth / 2,
    footerY + 7,
    { align: "center" },
  );

  // Page number
  doc.text(`Page 1`, pageWidth - 30, footerY + 14);

  return Buffer.from(doc.output("arraybuffer"));
}
