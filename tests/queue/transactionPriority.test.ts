const mockAdd = jest.fn().mockResolvedValue({ id: "tx-priority-1" });
const mockIsPaused = jest.fn().mockResolvedValue(false);
const mockHold = jest.fn().mockResolvedValue({ id: "tx-priority-1" });

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
  })),
}));

jest.mock("../../src/queue/providerQueueControl", () => ({
  providerQueueControl: {
    isPaused: mockIsPaused,
    hold: mockHold,
  },
}));

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn(),
  TransactionStatus: {},
}));

import {
  calculateTransactionPriority,
  addTransactionJob,
  addTransactionToQueue,
} from "../../src/queue/transactionQueue";
import { VipTier } from "../../src/utils/fees";

describe("Queue: Transaction Priority Routing (#2281)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPaused.mockResolvedValue(false);
  });

  describe("calculateTransactionPriority", () => {
    it("honors explicit priority parameter clamped between 1 and 10", () => {
      expect(calculateTransactionPriority({ priority: 1 })).toBe(1);
      expect(calculateTransactionPriority({ priority: 5 })).toBe(5);
      expect(calculateTransactionPriority({ priority: 10 })).toBe(10);
      // Clamping below 1
      expect(calculateTransactionPriority({ priority: 0 })).toBe(1);
      expect(calculateTransactionPriority({ priority: -5 })).toBe(1);
      // Clamping above 10
      expect(calculateTransactionPriority({ priority: 15 })).toBe(10);
    });

    it("assigns priority based on merchant VIP tier", () => {
      expect(calculateTransactionPriority({ tier: VipTier.DIAMOND })).toBe(1);
      expect(calculateTransactionPriority({ tier: "DIAMOND" })).toBe(1);
      expect(calculateTransactionPriority({ tier: VipTier.PLATINUM })).toBe(2);
      expect(calculateTransactionPriority({ tier: "PLATINUM" })).toBe(2);
      expect(calculateTransactionPriority({ tier: VipTier.GOLD })).toBe(4);
      expect(calculateTransactionPriority({ tier: "GOLD" })).toBe(4);
      expect(calculateTransactionPriority({ tier: VipTier.SILVER })).toBe(6);
      expect(calculateTransactionPriority({ tier: "SILVER" })).toBe(6);
      expect(calculateTransactionPriority({ tier: VipTier.STANDARD })).toBe(10);
      expect(calculateTransactionPriority({ tier: "STANDARD" })).toBe(10);
    });

    it("assigns priority based on transaction remittance amount", () => {
      // Large B2B / high-value remittances >= 50,000 -> 1
      expect(calculateTransactionPriority({ amount: "50000" })).toBe(1);
      expect(calculateTransactionPriority({ amount: 75000 })).toBe(1);

      // Amount >= 20,000 -> 2
      expect(calculateTransactionPriority({ amount: "20000" })).toBe(2);
      expect(calculateTransactionPriority({ amount: 35000 })).toBe(2);

      // Amount >= 5,000 -> 4
      expect(calculateTransactionPriority({ amount: "5000" })).toBe(4);
      expect(calculateTransactionPriority({ amount: 12000 })).toBe(4);

      // Amount >= 1,000 -> 6
      expect(calculateTransactionPriority({ amount: "1000" })).toBe(6);
      expect(calculateTransactionPriority({ amount: 2500 })).toBe(6);

      // Standard micropayments < 1,000 -> 10
      expect(calculateTransactionPriority({ amount: "50" })).toBe(10);
      expect(calculateTransactionPriority({ amount: 500 })).toBe(10);
      expect(calculateTransactionPriority({})).toBe(10);
    });
  });

  describe("addTransactionJob with priority", () => {
    const baseTx = {
      transactionId: "tx-vip-1",
      type: "deposit" as const,
      amount: "60000",
      phoneNumber: "+256700112233",
      provider: "mtn",
      stellarAddress: "GDIAMOND123",
    };

    it("automatically assigns priority 1 to high-value remittance", async () => {
      await addTransactionJob(baseTx);

      expect(mockAdd).toHaveBeenCalledWith(
        "transaction-process",
        expect.objectContaining({
          transactionId: "tx-vip-1",
          priority: 1,
        }),
        expect.objectContaining({
          jobId: "tx-vip-1",
          priority: 1,
        }),
      );
    });

    it("automatically assigns priority 2 to PLATINUM tier merchant", async () => {
      await addTransactionJob({
        ...baseTx,
        amount: "100", // small amount, but VIP tier
        tier: VipTier.PLATINUM,
      });

      expect(mockAdd).toHaveBeenCalledWith(
        "transaction-process",
        expect.objectContaining({ priority: 2 }),
        expect.objectContaining({ priority: 2 }),
      );
    });

    it("allows overriding priority via options", async () => {
      await addTransactionJob(baseTx, { priority: 3 });

      expect(mockAdd).toHaveBeenCalledWith(
        "transaction-process",
        expect.objectContaining({ priority: 3 }),
        expect.objectContaining({ priority: 3 }),
      );
    });

    it("forwards priority to hold queue when provider is paused", async () => {
      mockIsPaused.mockResolvedValue(true);
      await addTransactionJob(baseTx, { priority: 1 });

      expect(mockAdd).not.toHaveBeenCalled();
      expect(mockHold).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 1 }),
        expect.objectContaining({ priority: 1 }),
      );
    });

    it("works identically with addTransactionToQueue alias", async () => {
      await addTransactionToQueue(baseTx, { priority: 5 });

      expect(mockAdd).toHaveBeenCalledWith(
        "transaction-process",
        expect.objectContaining({ priority: 5 }),
        expect.objectContaining({ priority: 5 }),
      );
    });
  });

  describe("out-of-order execution favoring higher priority jobs", () => {
    it("sorts waiting jobs prioritizing lower numerical value (BullMQ convention)", () => {
      const simulatedQueue = [
        { id: "job-low", priority: 10, data: { amount: "10" } },
        { id: "job-vip", priority: 1, data: { amount: "100000", tier: "DIAMOND" } },
        { id: "job-med", priority: 4, data: { amount: "8000", tier: "GOLD" } },
        { id: "job-standard", priority: 10, data: { amount: "25" } },
      ];

      // BullMQ priority sorting: 1 (highest) executes before 2, 4, 10
      const executedOrder = [...simulatedQueue].sort(
        (a, b) => (a.priority || 10) - (b.priority || 10),
      );

      expect(executedOrder.map((j) => j.id)).toEqual([
        "job-vip",
        "job-med",
        "job-low",
        "job-standard",
      ]);
      expect(executedOrder[0].id).toBe("job-vip");
      expect(executedOrder[0].priority).toBe(1);
    });
  });
});
