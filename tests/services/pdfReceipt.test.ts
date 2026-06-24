import { generateTransactionPdfBuffer } from "../../src/services/pdfReceipt";
import { Transaction, TransactionStatus } from "../../src/models/transaction";

describe("pdfReceipt", () => {
  const baseTransaction: Transaction = {
    id: "tx-test-123",
    referenceNumber: "REF-TEST-123",
    type: "deposit",
    amount: "15000",
    phoneNumber: "+237670000000",
    provider: "MTN",
    status: TransactionStatus.Completed,
    userId: "user-test",
    createdAt: new Date("2026-06-01T12:00:00Z"),
    updatedAt: new Date("2026-06-01T12:05:00Z"),
  };

  it("should generate a PDF buffer successfully for USD", async () => {
    const transaction = {
      ...baseTransaction,
      currency: "USD",
    };

    const pdfBuffer = await generateTransactionPdfBuffer(transaction);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.slice(0, 4).toString()).toBe("%PDF");
  });

  it("should generate a PDF buffer successfully for XAF", async () => {
    const transaction = {
      ...baseTransaction,
      amount: "25000",
      currency: "XAF",
    };

    const pdfBuffer = await generateTransactionPdfBuffer(transaction);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.slice(0, 4).toString()).toBe("%PDF");
  });

  it("should fall back gracefully to a simple format if the currency is unsupported or invalid", async () => {
    const transaction = {
      ...baseTransaction,
      amount: "5000",
      currency: "INVALID_CURR",
    };

    // Should still succeed and produce a PDF even if CurrencyFormatter throws
    const pdfBuffer = await generateTransactionPdfBuffer(transaction);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.slice(0, 4).toString()).toBe("%PDF");
  });
});
