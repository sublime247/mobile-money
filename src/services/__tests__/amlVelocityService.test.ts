const mockUpdateStatus = jest.fn();
const mockSendAlert = jest.fn();
const mockAxiosPost = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../../config/redis", () => ({
  redisClient: {},
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../alertService", () => ({
  sendAlert: (...args: unknown[]) => mockSendAlert(...args),
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockAxiosPost(...args) },
}));

jest.mock("../aml", () => ({
  amlService: { raiseAlert: jest.fn() },
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
    addTags: jest.fn(),
    patchMetadata: jest.fn(),
    updateAdminNotes: jest.fn(),
    findById: jest.fn(),
  })),
  TransactionStatus: {
    Pending: "pending",
    PendingReview: "pending_review",
    Cancelled: "cancelled",
  },
}));

import {
  RecipientVelocityMonitor,
  RecipientVelocityStore,
  RECIPIENT_HOLD_KEY_PREFIX,
  RECIPIENT_VELOCITY_KEY_PREFIX,
  dispatchRecipientVelocityAlert,
  evaluateRecipientVelocity,
  getRecipientVelocityConfig,
} from "../amlVelocityService";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG = {
  windowMs: DAY_MS,
  maxTransfers: 10,
  corridorMaxXaf: 5_000_000,
  autoHold: false,
};

/** In-memory sorted-set stand-in that honours the window cutoff. */
function createMemoryStore(): RecipientVelocityStore & {
  entries: Map<string, { score: number; member: string }[]>;
  holds: Set<string>;
} {
  const entries = new Map<string, { score: number; member: string }[]>();
  const holds = new Set<string>();
  return {
    entries,
    holds,
    async pruneAndList(key, windowStart) {
      const list = (entries.get(key) ?? []).filter(
        (e) => e.score >= windowStart,
      );
      entries.set(key, list);
      return list.map((e) => e.member);
    },
    async add(key, member, score) {
      const list = entries.get(key) ?? [];
      list.push({ score, member });
      entries.set(key, list);
    },
    async setHold(key) {
      holds.add(key);
    },
    async hasHold(key) {
      return holds.has(key);
    },
  };
}

const PHONE = "+237 670 000 111";
const PHONE_KEY = "+237670000111";

function transfer(id: string, amount = 1000) {
  return { id, phoneNumber: PHONE, amount };
}

describe("evaluateRecipientVelocity", () => {
  it("does not breach on the 10th transfer and breaches on the 11th", () => {
    const tenth = evaluateRecipientVelocity({
      priorCount: 9,
      priorVolume: 0,
      amount: 1000,
      config: CONFIG,
    });
    expect(tenth.breached).toBe(false);
    expect(tenth.projectedCount).toBe(10);

    const eleventh = evaluateRecipientVelocity({
      priorCount: 10,
      priorVolume: 0,
      amount: 1000,
      config: CONFIG,
    });
    expect(eleventh.breached).toBe(true);
    expect(eleventh.reasons[0]).toContain("11 transfers");
  });

  it("breaches when the corridor volume maximum is exceeded", () => {
    const result = evaluateRecipientVelocity({
      priorCount: 1,
      priorVolume: 4_900_000,
      amount: 200_000,
      config: CONFIG,
    });
    expect(result.breached).toBe(true);
    expect(result.reasons).toEqual([
      expect.stringContaining("exceeds corridor maximum 5000000 XAF"),
    ]);
  });

  it("allows a transfer that lands exactly on the corridor maximum", () => {
    const result = evaluateRecipientVelocity({
      priorCount: 0,
      priorVolume: 4_000_000,
      amount: 1_000_000,
      config: CONFIG,
    });
    expect(result.breached).toBe(false);
  });
});

describe("RecipientVelocityMonitor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateStatus.mockResolvedValue(true);
    mockSendAlert.mockResolvedValue({ slack: "sent" });
    mockAxiosPost.mockResolvedValue({ status: 202 });
    delete process.env.AML_RECIPIENT_VELOCITY_ENABLED;
    delete process.env.PAGERDUTY_ROUTING_KEY;
  });

  it("holds the 11th transfer to a recipient and raises a critical alert", async () => {
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);
    const notify = jest.fn().mockResolvedValue(undefined);
    const now = Date.now();

    for (let i = 1; i <= 10; i++) {
      const result = await monitor.check(transfer(`tx-${i}`), {
        config: CONFIG,
        now,
        notify,
      });
      expect(result.held).toBe(false);
    }
    expect(notify).not.toHaveBeenCalled();

    const breach = await monitor.check(transfer("tx-11"), {
      config: CONFIG,
      now,
      notify,
    });
    expect(breach.held).toBe(true);
    expect(breach.evaluation?.projectedCount).toBe(11);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "tx-11",
      "pending_review",
      undefined,
      ["pending"],
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "tx-11",
        maskedRecipient: "***0111",
        projectedCount: 11,
      }),
    );
  });

  it("expires entries outside the sliding window", async () => {
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);
    const notify = jest.fn().mockResolvedValue(undefined);
    const start = Date.now() - DAY_MS - 1000;

    for (let i = 1; i <= 10; i++) {
      await monitor.check(transfer(`old-${i}`), {
        config: CONFIG,
        now: start,
        notify,
      });
    }

    // All ten earlier transfers are older than 24h, so the 11th is not a breach.
    const later = await monitor.check(transfer("fresh"), {
      config: CONFIG,
      now: Date.now(),
      notify,
    });
    expect(later.held).toBe(false);
    expect(later.evaluation?.projectedCount).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    expect(
      store.entries.get(`${RECIPIENT_VELOCITY_KEY_PREFIX}${PHONE_KEY}`),
    ).toHaveLength(1);
  });

  it("does not double count a transaction that is evaluated twice", async () => {
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);
    const now = Date.now();

    await monitor.check(transfer("same"), { config: CONFIG, now });
    const replay = await monitor.check(transfer("same"), {
      config: CONFIG,
      now,
    });

    expect(replay.evaluation?.projectedCount).toBe(1);
    expect(
      store.entries.get(`${RECIPIENT_VELOCITY_KEY_PREFIX}${PHONE_KEY}`),
    ).toHaveLength(1);
  });

  it("places subsequent transfers on hold when autoHold is enabled", async () => {
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);
    const notify = jest.fn().mockResolvedValue(undefined);
    const autoConfig = { ...CONFIG, maxTransfers: 2, autoHold: true };
    const now = Date.now();

    await monitor.check(transfer("a"), { config: autoConfig, now, notify });
    await monitor.check(transfer("b"), { config: autoConfig, now, notify });
    const third = await monitor.check(transfer("c"), {
      config: autoConfig,
      now,
      notify,
    });
    expect(third.held).toBe(true);
    expect(store.holds.has(`${RECIPIENT_HOLD_KEY_PREFIX}${PHONE_KEY}`)).toBe(
      true,
    );

    // A later, otherwise compliant transfer is held because of the recipient hold.
    const afterHold = await monitor.check(transfer("d", 10), {
      config: { ...autoConfig, maxTransfers: 100 },
      now,
      notify,
    });
    expect(afterHold.held).toBe(true);
    expect(afterHold.evaluation?.breached).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not hold later transfers when autoHold is disabled", async () => {
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);
    const notify = jest.fn().mockResolvedValue(undefined);
    const now = Date.now();
    const noHold = { ...CONFIG, maxTransfers: 1, autoHold: false };

    await monitor.check(transfer("a"), { config: noHold, now, notify });
    const second = await monitor.check(transfer("b"), {
      config: noHold,
      now,
      notify,
    });
    expect(second.held).toBe(true);
    expect(store.holds.size).toBe(0);

    const third = await monitor.check(transfer("c"), {
      config: { ...noHold, maxTransfers: 100 },
      now,
      notify,
    });
    expect(third.held).toBe(false);
  });

  it("is a no-op when the monitor is disabled", async () => {
    process.env.AML_RECIPIENT_VELOCITY_ENABLED = "false";
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);

    const result = await monitor.check(transfer("x"), { config: CONFIG });
    expect(result).toEqual({ held: false });
    expect(store.entries.size).toBe(0);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("does not notify when the hold could not be applied", async () => {
    mockUpdateStatus.mockResolvedValue(false);
    const store = createMemoryStore();
    const monitor = new RecipientVelocityMonitor(store);
    const notify = jest.fn().mockResolvedValue(undefined);
    const now = Date.now();

    for (let i = 1; i <= 10; i++) {
      await monitor.check(transfer(`n-${i}`), { config: CONFIG, now, notify });
    }
    const result = await monitor.check(transfer("n-11"), {
      config: CONFIG,
      now,
      notify,
    });
    expect(result.held).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("dispatchRecipientVelocityAlert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PAGERDUTY_ROUTING_KEY;
  });

  it("sends a Slack alert and skips PagerDuty when no routing key is set", async () => {
    await dispatchRecipientVelocityAlert({
      transactionId: "tx-9",
      maskedRecipient: "***0111",
      reasons: ["too many"],
      projectedCount: 11,
      projectedVolume: 1000,
    });

    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-9", severity: "critical" }),
      { cooldownMs: 0 },
    );
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("triggers a PagerDuty event when a routing key is configured", async () => {
    process.env.PAGERDUTY_ROUTING_KEY = "routing-key-test";

    await dispatchRecipientVelocityAlert({
      transactionId: "tx-10",
      maskedRecipient: "***0111",
      reasons: ["too many"],
      projectedCount: 11,
      projectedVolume: 1000,
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      "https://events.pagerduty.com/v2/enqueue",
      expect.objectContaining({
        routing_key: "routing-key-test",
        event_action: "trigger",
        dedup_key: "aml-recipient-tx-10",
      }),
      expect.any(Object),
    );
  });

  it("keeps working when the Slack webhook fails", async () => {
    mockSendAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(
      dispatchRecipientVelocityAlert({
        transactionId: "tx-11",
        maskedRecipient: "***0111",
        reasons: ["too many"],
        projectedCount: 11,
        projectedVolume: 1000,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("getRecipientVelocityConfig", () => {
  it("reads defaults and env overrides", () => {
    const original = { ...process.env };
    try {
      delete process.env.AML_RECIPIENT_MAX_TRANSFERS;
      delete process.env.AML_RECIPIENT_AUTO_HOLD;
      expect(getRecipientVelocityConfig()).toEqual({
        windowMs: DAY_MS,
        maxTransfers: 10,
        corridorMaxXaf: 5_000_000,
        autoHold: false,
      });

      process.env.AML_RECIPIENT_MAX_TRANSFERS = "3";
      process.env.AML_RECIPIENT_AUTO_HOLD = "true";
      expect(getRecipientVelocityConfig().maxTransfers).toBe(3);
      expect(getRecipientVelocityConfig().autoHold).toBe(true);
    } finally {
      process.env = original;
    }
  });
});
