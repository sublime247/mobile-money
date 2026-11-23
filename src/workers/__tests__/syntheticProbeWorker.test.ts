import {
  createHttpSyntheticProbeExecutor,
  SyntheticProbeWorker,
  syntheticTransactionDurationSeconds,
} from "../syntheticProbeWorker";

describe("SyntheticProbeWorker", () => {
  it("executes both testnet transaction legs and records roundtrip duration", async () => {
    const execute = jest.fn().mockResolvedValue({
      depositTransactionId: "deposit-1",
      withdrawalTransactionId: "withdrawal-1",
    });
    const alert = jest.fn();
    syntheticTransactionDurationSeconds.reset();
    const worker = new SyntheticProbeWorker(execute, alert);

    await expect(worker.runOnce()).resolves.toEqual({
      depositTransactionId: "deposit-1",
      withdrawalTransactionId: "withdrawal-1",
    });

    expect(execute).toHaveBeenCalledWith("0.01", "testnet");
    expect(alert).not.toHaveBeenCalled();
    expect(await syntheticTransactionDurationSeconds.get()).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({ labels: { status: "success" }, value: 1 }),
      ]),
    });
  });

  it("emits one critical alert after two consecutive failures", async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(new Error("anchor unavailable"));
    const alert = jest.fn();
    const worker = new SyntheticProbeWorker(execute, alert);

    await expect(worker.runOnce()).rejects.toThrow("anchor unavailable");
    expect(alert).not.toHaveBeenCalled();
    await expect(worker.runOnce()).rejects.toThrow("anchor unavailable");

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.any(Error));
  });

  it("calls the configured testnet runner with both lifecycle legs", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        deposit: { status: "completed", transactionId: "deposit-2" },
        withdrawal: { status: "completed", transactionId: "withdrawal-2" },
      }),
    } as Response);

    try {
      const execute = createHttpSyntheticProbeExecutor(
        "https://probe.example.test/run",
        "probe-token",
      );
      await expect(execute("0.01", "testnet")).resolves.toEqual({
        depositTransactionId: "deposit-2",
        withdrawalTransactionId: "withdrawal-2",
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        new URL("https://probe.example.test/run"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer probe-token",
          }),
          body: JSON.stringify({
            amount: "0.01",
            network: "testnet",
            lifecycle: ["deposit", "withdrawal"],
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
