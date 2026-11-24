import {
  authorizeTransactionTopic,
  buildTransactionTopic,
  msUntilTokenExpiry,
  parseTransactionTopic,
  scheduleTokenExpiry,
  WS_CLOSE_TOKEN_EXPIRED,
  WS_CLOSE_UNAUTHORIZED_TOPIC,
} from "../topicAuthorizer";

const TX_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_TX_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const USER_ID = "user-owner-1";

describe("parseTransactionTopic", () => {
  it("extracts the id from a well-formed transaction topic", () => {
    expect(parseTransactionTopic(`transaction:${TX_ID}`)).toBe(TX_ID);
  });

  it("rejects malformed or foreign topics", () => {
    expect(parseTransactionTopic("transaction:")).toBeNull();
    expect(parseTransactionTopic("transaction:not-a-uuid")).toBeNull();
    expect(parseTransactionTopic(`user:${TX_ID}`)).toBeNull();
    expect(parseTransactionTopic(`transaction:${TX_ID}/extra`)).toBeNull();
    expect(parseTransactionTopic(undefined)).toBeNull();
    expect(parseTransactionTopic(42)).toBeNull();
  });

  it("round-trips with buildTransactionTopic", () => {
    expect(parseTransactionTopic(buildTransactionTopic(TX_ID))).toBe(TX_ID);
  });
});

describe("authorizeTransactionTopic", () => {
  it("authorizes a subscription when the caller owns the transaction", async () => {
    const findOwnedTransaction = jest.fn().mockResolvedValue({ id: TX_ID });

    const result = await authorizeTransactionTopic({
      topic: buildTransactionTopic(TX_ID),
      userId: USER_ID,
      findOwnedTransaction,
    });

    expect(result).toEqual({
      allowed: true,
      topic: `transaction:${TX_ID}`,
      transactionId: TX_ID,
    });
    expect(findOwnedTransaction).toHaveBeenCalledWith(TX_ID, USER_ID);
  });

  it("rejects a topic for a transaction owned by someone else", async () => {
    const findOwnedTransaction = jest.fn().mockResolvedValue(null);

    const result = await authorizeTransactionTopic({
      topic: buildTransactionTopic(OTHER_TX_ID),
      userId: USER_ID,
      findOwnedTransaction,
    });

    expect(result).toEqual({
      allowed: false,
      topic: `transaction:${OTHER_TX_ID}`,
      reason: "forbidden_topic",
    });
  });

  it("rejects malformed topics without touching the database", async () => {
    const findOwnedTransaction = jest.fn();

    const result = await authorizeTransactionTopic({
      topic: "transaction:bogus",
      userId: USER_ID,
      findOwnedTransaction,
    });

    expect(result).toMatchObject({ allowed: false, reason: "invalid_topic" });
    expect(findOwnedTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when the ownership lookup errors", async () => {
    const findOwnedTransaction = jest
      .fn()
      .mockRejectedValue(new Error("db down"));

    const result = await authorizeTransactionTopic({
      topic: buildTransactionTopic(TX_ID),
      userId: USER_ID,
      findOwnedTransaction,
    });

    expect(result).toMatchObject({ allowed: false, reason: "lookup_failed" });
  });

  it("exposes distinct close codes for unauthorized topics and expired tokens", () => {
    expect(WS_CLOSE_UNAUTHORIZED_TOPIC).toBe(4403);
    expect(WS_CLOSE_TOKEN_EXPIRED).toBe(4401);
  });
});

describe("token expiry", () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("computes the remaining lifetime from the exp claim", () => {
    const exp = Math.floor(NOW / 1000) + 60;
    expect(msUntilTokenExpiry(exp, NOW)).toBe(60_000);
  });

  it("returns null for tokens without an exp claim", () => {
    expect(msUntilTokenExpiry(undefined, NOW)).toBeNull();
    expect(scheduleTokenExpiry(undefined, jest.fn(), NOW)).toBeNull();
  });

  it("fires the disconnect callback when the token expires", () => {
    const onExpire = jest.fn();
    const exp = Math.floor(NOW / 1000) + 30;

    scheduleTokenExpiry(exp, onExpire, NOW);
    jest.advanceTimersByTime(29_000);
    expect(onExpire).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("disconnects immediately when the token is already expired", () => {
    const onExpire = jest.fn();
    scheduleTokenExpiry(Math.floor(NOW / 1000) - 5, onExpire, NOW);
    jest.advanceTimersByTime(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
