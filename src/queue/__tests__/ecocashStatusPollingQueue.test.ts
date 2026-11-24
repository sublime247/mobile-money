/**
 * #2365: EcoCash status-poll job scheduling.
 */

type AddCall = { name: string; data: unknown; options: unknown };

class FakeQueue {
  public calls: AddCall[] = [];
  async add(name: string, data: unknown, options: unknown): Promise<void> {
    this.calls.push({ name, data, options });
  }
  async close(): Promise<void> {}
}

const fakeQueueInstance = new FakeQueue();

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => fakeQueueInstance),
}));

jest.mock("../config", () => ({
  queueOptions: {},
}));

import {
  scheduleEcoCashStatusPoll,
  scheduleNextEcoCashStatusPoll,
  ECOCASH_POLL_INTERVAL_MS,
  EcoCashStatusPollJobData,
} from "../ecocashStatusPollingQueue";

describe("EcoCash status polling queue (#2365)", () => {
  beforeEach(() => {
    fakeQueueInstance.calls.length = 0;
  });

  it("schedules the first poll at attempt 1 with the configured interval delay", async () => {
    const before = Date.now();
    await scheduleEcoCashStatusPoll("ecocash-disburse-abc");
    const after = Date.now();

    expect(fakeQueueInstance.calls).toHaveLength(1);
    const call = fakeQueueInstance.calls[0];
    expect(call.name).toBe("poll-ecocash-disburse-abc");

    const data = call.data as EcoCashStatusPollJobData;
    expect(data.referenceId).toBe("ecocash-disburse-abc");
    expect(data.attempt).toBe(1);
    expect(data.startedAt).toBeGreaterThanOrEqual(before);
    expect(data.startedAt).toBeLessThanOrEqual(after);

    expect(call.options).toMatchObject({ delay: ECOCASH_POLL_INTERVAL_MS });
  });

  it("schedules the next poll with attempt incremented and startedAt preserved", async () => {
    const previous: EcoCashStatusPollJobData = {
      referenceId: "ecocash-disburse-xyz",
      attempt: 4,
      startedAt: 1_700_000_000_000,
    };

    await scheduleNextEcoCashStatusPoll(previous);

    expect(fakeQueueInstance.calls).toHaveLength(1);
    const call = fakeQueueInstance.calls[0];
    expect(call.name).toBe("poll-ecocash-disburse-xyz");

    const data = call.data as EcoCashStatusPollJobData;
    expect(data.referenceId).toBe("ecocash-disburse-xyz");
    expect(data.attempt).toBe(5);
    expect(data.startedAt).toBe(1_700_000_000_000);
  });
});
