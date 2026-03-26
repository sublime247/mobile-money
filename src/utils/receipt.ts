type ReceiptAmount = number | string | null | undefined;
type ReceiptDateInput = Date | string | number | null | undefined;

export interface ReceiptTransaction {
  id: string;
  amount: ReceiptAmount;
  provider: string;
  status: string;
  phoneNumber?: string;
  stellarAddress?: string;
  sender?: string;
  receiver?: string;
  fee?: ReceiptAmount;
  total?: ReceiptAmount;
  transactionHash?: string;
  referenceNumber?: string;
  createdAt?: ReceiptDateInput;
  currency?: string;
}

export interface ReceiptOptions {
  generatedAt?: ReceiptDateInput;
  receiptNumber?: string;
}

const RECEIPT_COUNTERS = new Map<string, number>();

function formatReceiptDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function nextReceiptSequence(dateStamp: string): number {
  const nextSequence = (RECEIPT_COUNTERS.get(dateStamp) ?? 0) + 1;
  RECEIPT_COUNTERS.set(dateStamp, nextSequence);
  return nextSequence;
}

function toDate(value?: ReceiptDateInput): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value);
  }
  return new Date();
}

function parseAmount(value: ReceiptAmount): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatAmount(value: ReceiptAmount, currency: string): string {
  const parsedValue = parseAmount(value);
  if (parsedValue === null) return `0 ${currency}`;

  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number.isInteger(parsedValue) ? 0 : 2,
    maximumFractionDigits: 7,
  }).format(parsedValue)} ${currency}`;
}

function formatDate(value?: ReceiptDateInput): string {
  const date = toDate(value);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildReceiptViewModel(
  transaction: ReceiptTransaction,
  options: ReceiptOptions = {},
) {
  const generatedAt = toDate(options.generatedAt ?? transaction.createdAt);
  const dateStamp = formatReceiptDateStamp(generatedAt);
  const receiptNumber =
    options.receiptNumber ??
    `RCP-${dateStamp}-${String(nextReceiptSequence(dateStamp)).padStart(5, "0")}`;
  const currency = transaction.currency ?? "XAF";
  const amountValue = parseAmount(transaction.amount) ?? 0;
  const feeValue = parseAmount(transaction.fee) ?? 0;
  const totalValue = parseAmount(transaction.total) ?? amountValue + feeValue;

  return {
    receiptNumber,
    receiptDate: formatDate(generatedAt),
    amount: formatAmount(amountValue, currency),
    fee: formatAmount(feeValue, currency),
    total: formatAmount(totalValue, currency),
    provider: transaction.provider,
    status: toTitleCase(transaction.status),
    sender: transaction.sender ?? transaction.phoneNumber ?? "N/A",
    receiver: transaction.receiver ?? transaction.stellarAddress ?? "N/A",
    transactionId: transaction.id,
    referenceNumber: transaction.referenceNumber,
    transactionHash: transaction.transactionHash,
  };
}

/**
 * Generates a unique receipt number using the format `RCP-YYYYMMDD-XXXXX`.
 *
 * @example
 * const receiptNumber = generateReceiptNumber(new Date("2026-03-22T10:30:00Z"));
 * // RCP-20260322-00001
 */
export function generateReceiptNumber(generatedAt?: ReceiptDateInput): string {
  const date = toDate(generatedAt);
  const dateStamp = formatReceiptDateStamp(date);
  const sequence = nextReceiptSequence(dateStamp);
  return `RCP-${dateStamp}-${String(sequence).padStart(5, "0")}`;
}

/**
 * Generates a plain-text transaction receipt suitable for SMS previews or email bodies.
 *
 * @example
 * const receipt = generateReceipt({
 *   id: "abc123",
 *   amount: "10000",
 *   fee: "100",
 *   provider: "MTN Mobile Money",
 *   status: "completed",
 *   phoneNumber: "+237 6XX XXX XXX",
 *   stellarAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
 *   createdAt: "2026-03-22T10:30:00Z",
 * });
 */
export function generateReceipt(
  transaction: ReceiptTransaction,
  options: ReceiptOptions = {},
): string {
  const receipt = buildReceiptViewModel(transaction, options);
  const lines = [
    "========================================",
    "        TRANSACTION RECEIPT",
    "========================================",
    `Receipt No: ${receipt.receiptNumber}`,
    `Date: ${receipt.receiptDate}`,
    "",
    "Transaction Details:",
    `- Amount: ${receipt.amount}`,
    `- Fee: ${receipt.fee}`,
    `- Total: ${receipt.total}`,
    `- Provider: ${receipt.provider}`,
    `- Status: ${receipt.status}`,
    "",
    `From: ${receipt.sender}`,
    `To: ${receipt.receiver}`,
    "",
    `Transaction ID: ${receipt.transactionId}`,
  ];

  if (receipt.referenceNumber) {
    lines.push(`Reference No: ${receipt.referenceNumber}`);
  }

  if (receipt.transactionHash) {
    lines.push(`Stellar Hash: ${receipt.transactionHash}`);
  }

  lines.push(
    "",
    "Thank you for using our service!",
    "========================================",
  );

  return lines.join("\n");
}

/**
 * Generates an HTML receipt for email delivery.
 *
 * @example
 * const html = generateReceiptHtml(transaction);
 */
export function generateReceiptHtml(
  transaction: ReceiptTransaction,
  options: ReceiptOptions = {},
): string {
  const receipt = buildReceiptViewModel(transaction, options);

  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f0;border-radius:12px;overflow:hidden;">
      <div style="padding:24px;border-bottom:1px solid #dbe4f0;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Transaction Receipt</p>
        <h1 style="margin:0;font-size:24px;">${escapeHtml(receipt.receiptNumber)}</h1>
        <p style="margin:8px 0 0;color:#475569;">${escapeHtml(receipt.receiptDate)}</p>
      </div>
      <div style="padding:24px;">
        <h2 style="margin:0 0 12px;font-size:16px;">Transaction Details</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#64748b;">Amount</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.amount)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Fee</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.fee)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Total</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.total)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Provider</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.provider)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Status</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.status)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">From</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.sender)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">To</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.receiver)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Transaction ID</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.transactionId)}</td></tr>
          ${
            receipt.referenceNumber
              ? `<tr><td style="padding:8px 0;color:#64748b;">Reference No</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.referenceNumber)}</td></tr>`
              : ""
          }
          ${
            receipt.transactionHash
              ? `<tr><td style="padding:8px 0;color:#64748b;">Stellar Hash</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.transactionHash)}</td></tr>`
              : ""
          }
        </table>
      </div>
    </div>
  </body>
</html>`;
}
