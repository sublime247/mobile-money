import { EventEmitter } from "events";
import { EcoCashAdapter } from "../ecocashAdapter";
import { processEcoCashStatusPoll } from "../statusPoller";
import {
  EcoCashStatusPollJobData,
  ECOCASH_POLL_TIMEOUT_MS,
  scheduleNextEcoCashStatusPoll,
} from "../../../queue/ecocashStatusPollingQueue";

jest.mock("../../../queue/ecocashStatusPollingQueue", () => {
  const actual = jest.requireActual(
    "../../../queue/ecocashStatusPollingQueue",
  );
  return {
    ...actual,
    scheduleNextEcoCashStatusPoll: jest.fn(),
  };
});

const scheduleNextMock = scheduleNextEcoCashStatusPoll as jest.Mock;

function makeAdapterStub(
  status: "completed" | "failed" | "pending" | "unknown",
): EcoCashAdapter {
  return {
    getTransactionStatus: jest.fn().mockResolvedValue({ status }),
  } as unknown as EcoCashAdapter;
}

function makeJob(
  overrides: Partial<EcoCashStatusPollJobData> = {},
): EcoCashStatusPollJobData {
  return {
    referenceId: "ecocash-disburse-123",
    attempt: 1,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("processEcoCashStatusPoll (#2365)", () => {
  beforeEach(() => {
    scheduleNextMock.mockReset();
    scheduleNextMock.mockResolvedValue(undefined);
  });

  it("emits a SUCCESS resolution when the provider reports completed", async () => {
    const adapter = makeAdapterStub("completed");
    const emitter = new EventEmitter();
    const listener = jest.fn();
    emitter.on("resolved", listener);

    await processEcoCashStatusPoll(makeJob(), adapter, emitter);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: "ecocash-disburse-123",
        resolution: "SUCCESS",
        providerStatus: "completed",
        attempts: 1,
      }),
    );
    expect(scheduleNextMock).not.toHaveBeenCalled();
  });

  it("emits a FAILED resolution when the provider reports failed", async () => {
    const adapter = makeAdapterStub("failed");
    const emitter = new EventEmitter();
    const listener = jest.fn();
    emitter.on("resolved", listener);

    await processEcoCashStatusPoll(makeJob({ attempt: 2 }), adapter, emitter);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: "FAILED", attempts: 2 }),
    );
    expect(scheduleNextMock).not.toHaveBeenCalled();
  });

  it("schedules the next poll when the provider still reports pending", async () => {
    const adapter = makeAdapterStub("pending");
    const emitter = new EventEmitter();
    const listener = jest.fn();
    emitter.on("resolved", listener);
    const job = makeJob();

    await processEcoCashStatusPoll(job, adapter, emitter);

    expect(listener).not.toHaveBeenCalled();
    expect(scheduleNextMock).toHaveBeenCalledWith(job);
  });

  it("schedules the next poll when the provider status is unknown (e.g. a transient lookup failure)", async () => {
    const adapter = makeAdapterStub("unknown");
    const emitter = new EventEmitter();
    const listener = jest.fn();
    emitter.on("resolved", listener);
    const job = makeJob();

    await processEcoCashStatusPoll(job, adapter, emitter);

    expect(listener).not.toHaveBeenCalled();
    expect(scheduleNextMock).toHaveBeenCalledWith(job);
  });

  it("emits a TIMEOUT resolution once the poll window has elapsed, without scheduling another poll", async () => {
    const adapter = makeAdapterStub("pending");
    const emitter = new EventEmitter();
    const listener = jest.fn();
    emitter.on("resolved", listener);
    const job = makeJob({
      attempt: 12,
      startedAt: Date.now() - (ECOCASH_POLL_TIMEOUT_MS + 1000),
    });

    await processEcoCashStatusPoll(job, adapter, emitter);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "TIMEOUT",
        providerStatus: "pending",
        attempts: 12,
      }),
    );
    expect(scheduleNextMock).not.toHaveBeenCalled();
  });

  it("defaults to the module-level emitter when none is supplied, still invoking the injected adapter", async () => {
    const adapter = makeAdapterStub("completed");
    const job = makeJob({ referenceId: "ecocash-default-emitter" });

    // No emitter argument: processEcoCashStatusPoll should fall back to
    // ecocashStatusPollEvents without throwing, and still resolve the
    // provider status through the injected adapter.
    await expect(
      processEcoCashStatusPoll(job, adapter),
    ).resolves.toBeUndefined();
    expect(adapter.getTransactionStatus).toHaveBeenCalledWith(job.referenceId);
  });
});
