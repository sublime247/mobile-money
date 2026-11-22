const mockAdd = jest.fn().mockResolvedValue({ id: "tx-1" });
const mockIsPaused = jest.fn();
const mockHold = jest.fn().mockResolvedValue({ id: "tx-1" });

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
}));
jest.mock("../../src/queue/providerQueueControl", () => ({
  providerQueueControl: { isPaused: mockIsPaused, hold: mockHold },
}));
jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn(),
  TransactionStatus: {},
}));

import { addTransactionJob } from "../../src/queue/transactionQueue";

const data = {
  transactionId: "tx-1",
  type: "withdraw" as const,
  amount: "50",
  phoneNumber: "+256700000000",
  provider: "airtel",
  stellarAddress: "GTEST",
};

describe("addTransactionJob provider pause routing (#2282)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("dispatches to the main queue when the provider is active", async () => {
    mockIsPaused.mockResolvedValue(false);
    await addTransactionJob(data, { priority: 2 });

    expect(mockHold).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith(
      "transaction-process",
      expect.objectContaining({ transactionId: "tx-1" }),
      expect.objectContaining({ jobId: "tx-1", priority: 2 }),
    );
  });

  it("parks the job in the hold queue when the provider is paused", async () => {
    mockIsPaused.mockResolvedValue(true);
    const result = await addTransactionJob(data, { priority: 2 });

    expect(result).toEqual({ id: "tx-1" });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockHold).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-1", provider: "airtel" }),
      { jobId: undefined, priority: 2 },
    );
  });

  it("does not hold repeatable schedules", async () => {
    mockIsPaused.mockResolvedValue(true);
    await addTransactionJob(data, { repeat: { every: 60_000 } });

    expect(mockHold).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalled();
  });
});
