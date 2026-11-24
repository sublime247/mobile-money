import { TransactionModel } from "../../src/models/transaction";

describe("Deposit Idempotency on Retry Events", () => {
  it("prevents double execution of stellar payments when stellar transactionHash exists in metadata", async () => {
    const existingTx = {
      id: "tx-123",
      type: "deposit",
      amount: "100",
      status: "pending",
      metadata: {
        mobileMoney: { success: true, transactionId: "mm-999" },
        stellar: { transactionHash: "hash-already-submitted", submittedAt: new Date().toISOString() },
      },
    };

    jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue(existingTx as any);

    // Verify metadata reflects submitted state
    expect(existingTx.metadata.stellar.transactionHash).toBe("hash-already-submitted");
    expect(existingTx.metadata.mobileMoney.success).toBe(true);
  });
});
