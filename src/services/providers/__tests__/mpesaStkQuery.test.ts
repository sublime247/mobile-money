import {
  MPESA_STK_RESULT_CODES,
  MpesaStkQueryPoller,
  resolveMpesaStkQuery,
  resolveMpesaStkResult,
} from "../mpesaStkQuery";
import { TransactionStatus } from "../../../models/transaction";
import { MpesaStkQueryWorker } from "../../../workers/mpesaStkQueryWorker";

describe("resolveMpesaStkResult", () => {
  it("maps ResultCode 0 to a completed transaction", () => {
    const resolution = resolveMpesaStkResult(0, "Success");
    expect(resolution.status).toBe("completed");
    expect(resolution.transactionStatus).toBe(TransactionStatus.Completed);
    expect(resolution.terminal).toBe(true);
  });

  it("maps ResultCode 1032 (cancelled by user) to cancelled", () => {
    const resolution = resolveMpesaStkResult(1032);
    expect(resolution.status).toBe("cancelled");
    expect(resolution.transactionStatus).toBe(TransactionStatus.Cancelled);
    expect(resolution.userMessage).toMatch(/cancelled/i);
  });

  it("maps ResultCode 1037 (no response from user) to expired", () => {
    const resolution = resolveMpesaStkResult(1037);
    expect(resolution.status).toBe("expired");
    expect(resolution.transactionStatus).toBe(TransactionStatus.Expired);
    expect(resolution.userMessage).toMatch(/timed out/i);
  });

  it("treats a missing result code as non-terminal pending", () => {
    const resolution = resolveMpesaStkResult(undefined);
    expect(resolution.status).toBe("pending");
    expect(resolution.terminal).toBe(false);
  });

  it("treats an unknown non-zero code as a terminal failure", () => {
    const resolution = resolveMpesaStkResult(4242, "Mystery");
    expect(resolution.status).toBe("failed");
    expect(resolution.terminal).toBe(true);
    expect(resolution.resultCode).toBe(4242);
  });

  it("documents the accepted Safaricom codes", () => {
    expect(Object.keys(MPESA_STK_RESULT_CODES).map(Number)).toEqual(
      expect.arrayContaining([0, 1032, 1037, 2001]),
    );
  });
});

describe("resolveMpesaStkQuery", () => {
  it("keeps polling when the transport call failed", () => {
    const resolution = resolveMpesaStkQuery({ success: false });
    expect(resolution.status).toBe("pending");
    expect(resolution.terminal).toBe(false);
  });

  it("resolves a successful query response from its result code", () => {
    const resolution = resolveMpesaStkQuery({
      success: true,
      resultCode: 1032,
      resultDesc: "Request cancelled by user",
    });
    expect(resolution.status).toBe("cancelled");
  });
});

describe("MpesaStkQueryPoller", () => {
  const target = {
    transactionId: "txn-1",
    checkoutRequestId: "checkout-1",
    userId: "user-1",
    phoneNumber: "254712345678",
  };

  it("polls until a terminal result and persists it", async () => {
    const queryStkPush = jest
      .fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, resultCode: 0 });
    const updateStatus = jest.fn().mockResolvedValue(true);
    const notifyUser = jest.fn();
    const sleep = jest.fn().mockResolvedValue(undefined);

    const poller = new MpesaStkQueryPoller({
      provider: { queryStkPush },
      transactionModel: { updateStatus },
      notifyUser,
      sleep,
      maxAttempts: 3,
    });

    const resolution = await poller.poll(target);

    expect(queryStkPush).toHaveBeenCalledTimes(2);
    expect(resolution.status).toBe("completed");
    expect(updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Completed,
      "user-1",
    );
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "txn-1",
        checkoutRequestId: "checkout-1",
        status: "completed",
      }),
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("maps a 1032 query response to cancelled and notifies the user", async () => {
    const queryStkPush = jest.fn().mockResolvedValue({
      success: true,
      resultCode: 1032,
      resultDesc: "Request cancelled by user",
    });
    const updateStatus = jest.fn().mockResolvedValue(true);
    const notifyUser = jest.fn();

    const poller = new MpesaStkQueryPoller({
      provider: { queryStkPush },
      transactionModel: { updateStatus },
      notifyUser,
      sleep: jest.fn().mockResolvedValue(undefined),
      maxAttempts: 2,
    });

    const resolution = await poller.poll(target);

    expect(resolution.status).toBe("cancelled");
    expect(updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Cancelled,
      "user-1",
    );
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", resultCode: 1032 }),
    );
  });

  it("expires the transaction when the query never resolves", async () => {
    const queryStkPush = jest.fn().mockResolvedValue({ success: false });
    const updateStatus = jest.fn().mockResolvedValue(true);

    const poller = new MpesaStkQueryPoller({
      provider: { queryStkPush },
      transactionModel: { updateStatus },
      sleep: jest.fn().mockResolvedValue(undefined),
      maxAttempts: 2,
    });

    const resolution = await poller.poll(target);

    expect(queryStkPush).toHaveBeenCalledTimes(2);
    expect(resolution.status).toBe("expired");
    expect(updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Expired,
      "user-1",
    );
  });

  it("arms a timeout and queries only after the callback window elapses", async () => {
    jest.useFakeTimers();
    try {
      const queryStkPush = jest.fn().mockResolvedValue({
        success: true,
        resultCode: 0,
      });
      const updateStatus = jest.fn().mockResolvedValue(true);

      const poller = new MpesaStkQueryPoller({
        provider: { queryStkPush },
        transactionModel: { updateStatus },
        timeoutMs: 30_000,
        sleep: jest.fn().mockResolvedValue(undefined),
      });

      poller.schedule(target);
      expect(poller.isTracking("checkout-1")).toBe(true);

      await jest.advanceTimersByTimeAsync(29_000);
      expect(queryStkPush).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(queryStkPush).toHaveBeenCalledWith("checkout-1");
      expect(updateStatus).toHaveBeenCalledWith(
        "txn-1",
        TransactionStatus.Completed,
        "user-1",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("cancels polling when the callback arrives in time", () => {
    jest.useFakeTimers();
    try {
      const queryStkPush = jest.fn();

      const poller = new MpesaStkQueryPoller({
        provider: { queryStkPush },
        transactionModel: { updateStatus: jest.fn() },
      });

      poller.schedule(target);
      expect(poller.cancel("checkout-1")).toBe(true);
      expect(poller.cancel("checkout-1")).toBe(false);
      expect(poller.isTracking("checkout-1")).toBe(false);

      jest.advanceTimersByTime(60_000);
      expect(queryStkPush).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("MpesaStkQueryWorker", () => {
  const target = { transactionId: "txn-1", checkoutRequestId: "checkout-1" };

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not schedule while stopped", () => {
    const worker = new MpesaStkQueryWorker({
      provider: { queryStkPush: jest.fn() },
      transactionModel: { updateStatus: jest.fn() },
    });

    expect(worker.onStkPushInitiated(target)).toBe(false);
    expect(worker.getStats().active).toBe(0);
  });

  it("schedules, cancels on callback, and reports stats", () => {
    jest.useFakeTimers();
    const worker = new MpesaStkQueryWorker({
      provider: { queryStkPush: jest.fn() },
      transactionModel: { updateStatus: jest.fn() },
      autostart: true,
    });

    expect(worker.isRunning()).toBe(true);
    expect(worker.onStkPushInitiated(target)).toBe(true);
    expect(worker.getStats().active).toBe(1);

    expect(worker.onStkCallback("checkout-1")).toBe(true);
    expect(worker.getStats().cancelledByCallback).toBe(1);
    expect(worker.getStats().active).toBe(0);

    worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});
