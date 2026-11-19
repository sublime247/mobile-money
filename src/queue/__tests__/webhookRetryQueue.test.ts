const mockGetCounts = jest.fn();
const mockGetJobs = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();
const mockRunCommand = jest.fn();

jest.mock("bullmq", () => ({
  Queue: jest.fn(() => ({
    getJobCounts: mockGetCounts,
    getJobs: mockGetJobs,
    client: Promise.resolve({
      get: mockGet,
      set: mockSet,
      del: mockDel,
      defineCommand: jest.fn(),
      runCommand: mockRunCommand,
    }),
    toKey: (suffix: string) => `bull:retry:${suffix}`,
    close: jest.fn(),
  })),
}));

jest.mock("../../services/alertService", () => ({
  ...jest.requireActual("../../services/alertService"),
  dispatchWebhookBacklogAlert: jest.fn(),
}));

import {
  closeWebhookRetryQueue,
  startWebhookRetryBacklogWatcher,
} from "../webhookRetryQueue";
import { dispatchWebhookBacklogAlert } from "../../services/alertService";

const dispatch = jest.mocked(dispatchWebhookBacklogAlert);
const priorKey = process.env.PAGERDUTY_INTEGRATION_KEY;
const priorDedupKey = process.env.PAGERDUTY_DEDUP_KEY;
const incidentKey = "bull:retry:pagerduty:queue-test-webhook-retry-backlog";

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  process.env.PAGERDUTY_INTEGRATION_KEY = "test-routing-key";
  process.env.PAGERDUTY_DEDUP_KEY = "queue-test";
  mockRunCommand.mockResolvedValue("OK");
});

afterEach(async () => {
  await closeWebhookRetryQueue();
  jest.useRealTimers();
  if (priorKey === undefined) delete process.env.PAGERDUTY_INTEGRATION_KEY;
  else process.env.PAGERDUTY_INTEGRATION_KEY = priorKey;
  if (priorDedupKey === undefined) delete process.env.PAGERDUTY_DEDUP_KEY;
  else process.env.PAGERDUTY_DEDUP_KEY = priorDedupKey;
});

it("pages for aged delayed work and resolves a recovered queue", async () => {
  mockGetCounts
    .mockResolvedValueOnce({ delayed: 1 })
    .mockResolvedValueOnce({ waiting: 0 });
  mockGetJobs.mockResolvedValueOnce([{ timestamp: Date.now() - 910_000 }]);
  mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce("trigger");

  startWebhookRetryBacklogWatcher();
  await jest.advanceTimersByTimeAsync(0);
  expect(dispatch).toHaveBeenCalledWith(
    "test-routing-key",
    "queue-test-webhook-retry-backlog",
    "trigger",
    { depth: 1, oldestAgeSeconds: 910 },
  );
  expect(mockSet).toHaveBeenCalledWith(incidentKey, "trigger");

  await jest.advanceTimersByTimeAsync(30_000);
  expect(dispatch).toHaveBeenLastCalledWith(
    "test-routing-key",
    "queue-test-webhook-retry-backlog",
    "resolve",
    { depth: 0, oldestAgeSeconds: 0 },
  );
  expect(mockDel).toHaveBeenCalledWith(incidentKey);
});

it("respects the distributed lock and retries an unsuccessful delivery", async () => {
  mockGetCounts.mockResolvedValue({ waiting: 501 });
  mockRunCommand.mockResolvedValueOnce(null);
  dispatch.mockRejectedValueOnce(new Error("PagerDuty unreachable"));

  startWebhookRetryBacklogWatcher();
  await jest.advanceTimersByTimeAsync(0);
  expect(dispatch).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(30_000);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(mockSet).not.toHaveBeenCalledWith(incidentKey, "trigger");

  await jest.advanceTimersByTimeAsync(30_000);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(mockSet).toHaveBeenCalledWith(incidentKey, "trigger");
});
