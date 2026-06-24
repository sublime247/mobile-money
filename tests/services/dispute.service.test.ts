import { DisputeService } from "../../src/services/dispute";
import { TransactionModel, TransactionStatus } from "../../src/models/transaction";
import { Dispute, DisputeModel } from "../../src/models/dispute";

describe("DisputeService", () => {
  const txId = "00000000-0000-0000-0000-000000000001";
  const baseTransaction = {
    id: txId,
    userId: "00000000-0000-0000-0000-000000000099",
    referenceNumber: "TXN-1",
    type: "deposit",
    amount: "1",
    phoneNumber: "+237600000000",
    provider: "mtn",
    stellarAddress: "G".padEnd(56, "A"),
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseDispute = (overrides: Partial<Dispute> = {}): Dispute => ({
    id: "d1",
    transactionId: txId,
    reason: "test",
    status: "open",
    assignedTo: null,
    resolution: null,
    reportedBy: null,
    priority: "medium",
    category: null,
    slaDueDate: null,
    slaWarningSent: false,
    internalNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects dispute when transaction is pending", async () => {
    jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
      ...baseTransaction,
      status: TransactionStatus.Pending,
    });

    jest.spyOn(DisputeModel.prototype, "findActiveByTransactionId").mockResolvedValue(null);

    const svc = new DisputeService();
    await expect(svc.openDispute(txId, "wrong amount")).rejects.toThrow(
      "only allowed for completed or failed",
    );
  });

  it("opens dispute for completed transaction", async () => {
    jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
      ...baseTransaction,
      status: TransactionStatus.Completed,
    });

    jest.spyOn(DisputeModel.prototype, "findActiveByTransactionId").mockResolvedValue(null);
    jest.spyOn(DisputeModel.prototype, "create").mockResolvedValue(baseDispute());
    const updateStatus = jest
      .spyOn(TransactionModel.prototype, "updateStatus")
      .mockResolvedValue(undefined);

    const svc = new DisputeService();
    const d = await svc.openDispute(txId, "test");
    expect(d.id).toBe("d1");
    expect(DisputeModel.prototype.create).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(txId, TransactionStatus.Dispute);
  });

  it("lets admin reverse a disputed payment", async () => {
    const dispute = baseDispute({ status: "investigating" });
    jest.spyOn(DisputeModel.prototype, "findById").mockResolvedValue(dispute);
    jest.spyOn(DisputeModel.prototype, "update").mockResolvedValue(
      baseDispute({
        status: "reversed",
        resolution: "Merchant evidence did not validate payment",
        assignedTo: "admin-1",
      }),
    );
    const updateStatus = jest
      .spyOn(TransactionModel.prototype, "updateStatus")
      .mockResolvedValue(undefined);
    const addNote = jest.spyOn(DisputeModel.prototype, "addNote").mockResolvedValue({
      id: "note-1",
      disputeId: "d1",
      author: "admin-1",
      note: "Admin reversed payment: Merchant evidence did not validate payment",
      createdAt: new Date(),
    });

    const svc = new DisputeService();
    const result = await svc.resolvePayment(
      "d1",
      "reverse",
      "Merchant evidence did not validate payment",
      "admin-1",
    );

    expect(result.status).toBe("reversed");
    expect(updateStatus).toHaveBeenCalledWith(txId, TransactionStatus.Reversed);
    expect(addNote).toHaveBeenCalledWith(
      "d1",
      "admin-1",
      expect.stringContaining("reversed"),
    );
  });

  it("lets admin uphold a disputed payment", async () => {
    const dispute = baseDispute({ status: "investigating" });
    jest.spyOn(DisputeModel.prototype, "findById").mockResolvedValue(dispute);
    jest.spyOn(DisputeModel.prototype, "update").mockResolvedValue(
      baseDispute({
        status: "upheld",
        resolution: "Merchant evidence confirms delivery",
        assignedTo: "admin-1",
      }),
    );
    const updateStatus = jest
      .spyOn(TransactionModel.prototype, "updateStatus")
      .mockResolvedValue(undefined);
    const addNote = jest.spyOn(DisputeModel.prototype, "addNote").mockResolvedValue({
      id: "note-1",
      disputeId: "d1",
      author: "admin-1",
      note: "Admin upheld payment: Merchant evidence confirms delivery",
      createdAt: new Date(),
    });

    const svc = new DisputeService();
    const result = await svc.resolvePayment(
      "d1",
      "uphold",
      "Merchant evidence confirms delivery",
      "admin-1",
    );

    expect(result.status).toBe("upheld");
    expect(updateStatus).toHaveBeenCalledWith(txId, TransactionStatus.Completed);
    expect(addNote).toHaveBeenCalledWith(
      "d1",
      "admin-1",
      expect.stringContaining("upheld"),
    );
  });

  it("rejects reverse or uphold on terminal disputes", async () => {
    jest
      .spyOn(DisputeModel.prototype, "findById")
      .mockResolvedValue(baseDispute({ status: "upheld" }));

    const svc = new DisputeService();
    await expect(
      svc.resolvePayment("d1", "reverse", "customer asks again", "admin-1"),
    ).rejects.toThrow("Cannot resolve a upheld dispute");
  });
});
