const workerInstances: Array<{
  processor: (job: any) => Promise<any>;
  events: Record<string, Function>;
}> = [];

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    getJob: jest.fn(),
    getWaitingCount: jest.fn(),
    getActiveCount: jest.fn(),
    getCompletedCount: jest.fn(),
    getFailedCount: jest.fn(),
    isPaused: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    drain: jest.fn(),
  })),
  Worker: jest
    .fn()
    .mockImplementation(
      (_name: string, processor: (job: any) => Promise<any>) => {
        const instance = {
          processor,
          events: {} as Record<string, Function>,
          on(event: string, handler: Function) {
            instance.events[event] = handler;
          },
          close: jest.fn(async () => undefined),
        };
        workerInstances.push(instance);
        return instance;
      },
    ),
}));

jest.mock("../../src/queue/config", () => ({
  queueOptions: {},
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  TRANSACTION_QUEUE_NAME: "transaction-processing",
}));

const mockTransactionModel = {
  updateStatus: jest.fn(),
  findById: jest.fn(),
  updateWebhookDelivery: jest.fn(),
};

const mockMobileMoneyService = {
  initiatePayment: jest.fn(),
  sendPayout: jest.fn(),
};

const mockStellarService = {
  sendPayment: jest.fn(),
};

const mockNotifyTransactionWebhook = jest.fn();

jest.mock("../../src/models/transaction", () => {
  const actual = jest.requireActual("../../src/models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => mockTransactionModel),
  };
});

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest
    .fn()
    .mockImplementation(() => mockMobileMoneyService),
}));

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => mockStellarService),
}));

jest.mock("../../src/services/webhook", () => ({
  WebhookService: jest.fn().mockImplementation(() => ({})),
  notifyTransactionWebhook: (...args: unknown[]) =>
    mockNotifyTransactionWebhook(...args),
}));

import { TransactionStatus } from "../../src/models/transaction";
import "../../src/queue/worker";

function getProcessor() {
  expect(workerInstances).toHaveLength(1);
  return workerInstances[0].processor;
}

function buildJob(dataOverrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    attemptsMade: 0,
    data: {
      transactionId: "txn-1",
      type: "deposit",
      amount: "10000",
      phoneNumber: "+237670000000",
      provider: "mtn",
      stellarAddress: `G${"A".repeat(55)}`,
      ...dataOverrides,
    },
    updateProgress: jest.fn(async () => undefined),
  };
}

describe("transaction worker webhook integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMobileMoneyService.initiatePayment.mockResolvedValue({ success: true });
    mockMobileMoneyService.sendPayout.mockResolvedValue({ success: true });
    mockStellarService.sendPayment.mockResolvedValue(undefined);
    mockNotifyTransactionWebhook.mockResolvedValue({
      status: "delivered",
    });
  });

  it("sends a completed webhook after a successful deposit", async () => {
    const processor = getProcessor();
    const job = buildJob();

    const result = await processor(job);

    expect(result).toEqual({
      success: true,
      transactionId: "txn-1",
    });
    expect(mockTransactionModel.updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Completed,
    );
    expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
      "txn-1",
      "transaction.completed",
      expect.objectContaining({
        transactionModel: mockTransactionModel,
      }),
    );
  });

  it("sends a failed webhook when transaction processing throws", async () => {
    const processor = getProcessor();
    const job = buildJob();

    mockMobileMoneyService.initiatePayment.mockResolvedValue({
      success: false,
      error: "provider outage",
    });

    await expect(processor(job)).rejects.toThrow("provider outage");

    expect(mockTransactionModel.updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Failed,
    );
    expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
      "txn-1",
      "transaction.failed",
      expect.objectContaining({
        transactionModel: mockTransactionModel,
      }),
    );
  });
});
