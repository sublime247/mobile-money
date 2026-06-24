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
  Worker: jest.fn(),
}));

const consumers: Array<{
  queue: string;
  processor: (data: any, msg?: any) => Promise<void>;
  concurrency?: number;
}> = [];

jest.mock("../../src/queue/config", () => ({
  queueOptions: {},
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  TRANSACTION_QUEUE_NAME: "transaction-processing",
}));

jest.mock("../../src/queue/rabbitmq", () => ({
  EXCHANGES: {
    TRANSACTIONS: "transactions.topic",
  },
  ROUTING_KEYS: {
    TRANSACTION_COMPLETED: "transaction.completed",
    TRANSACTION_FAILED: "transaction.failed",
  },
  QUEUES: {
    TRANSACTION_PROCESSING: "transaction-processing-queue",
  },
  rabbitMQManager: {
    consume: jest.fn((queue, processor, concurrency) => {
      consumers.push({ queue, processor, concurrency });
      return Promise.resolve();
    }),
    publish: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../src/graphql/redisPubSub", () => ({
  getRedisPubSub: () => ({
    publish: jest.fn(),
    asyncIterator: jest.fn(),
  }),
}));

const mockTransactionModel = {
  updateStatus: jest.fn(),
  findById: jest.fn(),
  patchMetadata: jest.fn(),
  updateMetadata: jest.fn(),
  incrementRetryCount: jest.fn(),
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
  MobileMoneyService: jest.fn().mockImplementation(() => mockMobileMoneyService),
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
  expect(consumers).toHaveLength(1);
  return async (job: any) => {
    let result: any;
    await consumers[0].processor(job.data, {});
    if (mockTransactionModel.updateStatus.mock.calls.some(
      ([, status]) => status === TransactionStatus.Failed,
    )) {
      throw new Error("provider outage");
    }
    if (mockTransactionModel.updateStatus.mock.calls.some(
      ([, status]) => status === TransactionStatus.Completed,
    )) {
      result = { success: true, transactionId: job.data.transactionId };
    }
    return result;
  };
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
    consumers.splice(1);
    process.env.MAX_RETRY_ATTEMPTS = "1";
    mockMobileMoneyService.initiatePayment.mockResolvedValue({ success: true });
    mockMobileMoneyService.sendPayout.mockResolvedValue({ success: true });
    mockStellarService.sendPayment.mockResolvedValue({
      hash: "stellar-hash",
      submittedAt: new Date("2026-06-10T00:00:00Z"),
    });
    mockTransactionModel.findById.mockResolvedValue(null);
    mockTransactionModel.patchMetadata.mockResolvedValue(undefined);
    mockTransactionModel.updateMetadata.mockResolvedValue(undefined);
    mockTransactionModel.incrementRetryCount.mockResolvedValue(undefined);
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
