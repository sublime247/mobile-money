export {};

const mockAdd = jest.fn();
const mockClose = jest.fn();
const mockQueueCtor = jest.fn(() => ({
  add: mockAdd,
  close: mockClose,
}));

jest.mock("bullmq", () => ({
  Queue: mockQueueCtor,
}));

jest.mock("../../queue/config", () => ({
  queueOptions: {},
}));

describe("providerBalanceAlertQueue", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("schedules repeatable job every 10 minutes by default", async () => {
    const { scheduleProviderBalanceAlertJob } =
      await import("../../queue/providerBalanceAlertQueue");

    await scheduleProviderBalanceAlertJob();

    expect(mockAdd).toHaveBeenCalledWith(
      "check-provider-balances",
      { triggeredBy: "scheduler" },
      expect.objectContaining({
        jobId: "check-provider-balances",
        repeat: { every: 600000 },
        attempts: 3,
      }),
    );
  });

  it("uses custom interval when PROVIDER_BALANCE_ALERT_INTERVAL_MS is valid", async () => {
    process.env.PROVIDER_BALANCE_ALERT_INTERVAL_MS = "900000";
    const { scheduleProviderBalanceAlertJob } =
      await import("../../queue/providerBalanceAlertQueue");

    await scheduleProviderBalanceAlertJob();

    expect(mockAdd).toHaveBeenCalledWith(
      "check-provider-balances",
      { triggeredBy: "scheduler" },
      expect.objectContaining({
        repeat: { every: 900000 },
      }),
    );
  });

  it("falls back to default interval when configured value is too low", async () => {
    process.env.PROVIDER_BALANCE_ALERT_INTERVAL_MS = "1000";
    const { scheduleProviderBalanceAlertJob } =
      await import("../../queue/providerBalanceAlertQueue");

    await scheduleProviderBalanceAlertJob();

    expect(mockAdd).toHaveBeenCalledWith(
      "check-provider-balances",
      { triggeredBy: "scheduler" },
      expect.objectContaining({
        repeat: { every: 600000 },
      }),
    );
  });
});
