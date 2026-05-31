import { DisputeService } from "../../src/services/dispute";
import {
  TransactionModel,
  TransactionStatus,
} from "../../src/models/transaction";
import { DisputeModel } from "../../src/models/dispute";

describe("DisputeService", () => {
  const txId = "00000000-0000-0000-0000-000000000001";

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects dispute when transaction is pending", async () => {
    jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
      id: txId,
      referenceNumber: "TXN-1",
      type: "deposit",
      amount: "1",
      phoneNumber: "+237600000000",
      provider: "mtn",
      stellarAddress: "G".padEnd(56, "A"),
      status: TransactionStatus.Pending,
      tags: [],
      createdAt: new Date(),
    });

    jest
      .spyOn(DisputeModel.prototype, "findActiveByTransactionId")
      .mockResolvedValue(null);

    const svc = new DisputeService();
    await expect(svc.openDispute(txId, "wrong amount")).rejects.toThrow(
      "only allowed for completed or failed",
    );
  });

  it("opens dispute for completed transaction", async () => {
    jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
      id: txId,
      referenceNumber: "TXN-1",
      type: "deposit",
      amount: "1",
      phoneNumber: "+237600000000",
      provider: "mtn",
      stellarAddress: "G".padEnd(56, "A"),
      status: TransactionStatus.Completed,
      tags: [],
      createdAt: new Date(),
    });

    jest
      .spyOn(DisputeModel.prototype, "findActiveByTransactionId")
      .mockResolvedValue(null);
    jest.spyOn(DisputeModel.prototype, "create").mockResolvedValue({
      id: "d1",
      transactionId: txId,
      reason: "test",
      status: "open",
      assignedTo: null,
      resolution: null,
      reportedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const svc = new DisputeService();
    const d = await svc.openDispute(txId, "test");
    expect(d.id).toBe("d1");
    expect(DisputeModel.prototype.create).toHaveBeenCalled();
  });
});
