export {};

const mockOn = jest.fn();
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerCtor = jest.fn(() => ({
  on: mockOn,
  close: mockClose,
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
  Worker: mockWorkerCtor,
}));

jest.mock("../../queue/config", () => ({
  queueOptions: {},
}));

const mockRunProviderBalanceAlertJob = jest.fn().mockResolvedValue(undefined);

jest.mock("../../jobs/balances", () => ({
  runProviderBalanceAlertJob: () => mockRunProviderBalanceAlertJob(),
}));

describe("providerBalanceAlertWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts worker once and closes cleanly", async () => {
    const { startProviderBalanceAlertWorker, closeProviderBalanceAlertWorker } =
      await import("../../queue/providerBalanceAlertWorker");

    startProviderBalanceAlertWorker();
    startProviderBalanceAlertWorker();

    expect(mockWorkerCtor).toHaveBeenCalledTimes(1);

    await closeProviderBalanceAlertWorker();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
