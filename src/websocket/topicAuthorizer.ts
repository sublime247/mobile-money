/**
 * Scoped topic authorization for the transaction WebSocket stream.
 *
 * A client may only subscribe to `transaction:{id}` when that transaction
 * belongs to the authenticated user. Ownership is checked against the database
 * (the same user-scoped lookup used by `transaction.details`), so a guessed or
 * leaked transaction id is not enough to eavesdrop on another customer's
 * progress updates.
 */

export const TRANSACTION_TOPIC_PREFIX = "transaction:";

/** Custom close code for a subscription to a topic the caller does not own. */
export const WS_CLOSE_UNAUTHORIZED_TOPIC = 4403;
/** Custom close code when the JWT backing the socket expires. */
export const WS_CLOSE_TOKEN_EXPIRED = 4401;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TopicDenialReason =
  "invalid_topic" | "forbidden_topic" | "lookup_failed";

export type TopicAuthorizationResult =
  | { allowed: true; topic: string; transactionId: string }
  | { allowed: false; topic: string; reason: TopicDenialReason };

/** Returns the transaction id for a `transaction:{id}` topic, or null if malformed. */
export function parseTransactionTopic(topic: unknown): string | null {
  if (
    typeof topic !== "string" ||
    !topic.startsWith(TRANSACTION_TOPIC_PREFIX)
  ) {
    return null;
  }
  const transactionId = topic.slice(TRANSACTION_TOPIC_PREFIX.length);
  return UUID_PATTERN.test(transactionId) ? transactionId : null;
}

export function buildTransactionTopic(transactionId: string): string {
  return `${TRANSACTION_TOPIC_PREFIX}${transactionId}`;
}

/**
 * Authorizes a subscription request. `findOwnedTransaction` must return null
 * for transactions the user does not own (for example a user-scoped
 * `TransactionModel.findById(id, userId)`). Any lookup error fails closed.
 */
export async function authorizeTransactionTopic(params: {
  topic: unknown;
  userId: string;
  findOwnedTransaction: (
    transactionId: string,
    userId: string,
  ) => Promise<unknown | null>;
}): Promise<TopicAuthorizationResult> {
  const topicLabel =
    typeof params.topic === "string" ? params.topic : String(params.topic);
  const transactionId = parseTransactionTopic(params.topic);
  if (!transactionId) {
    return { allowed: false, topic: topicLabel, reason: "invalid_topic" };
  }

  try {
    const owned = await params.findOwnedTransaction(
      transactionId,
      params.userId,
    );
    if (!owned) {
      return { allowed: false, topic: topicLabel, reason: "forbidden_topic" };
    }
    return { allowed: true, topic: topicLabel, transactionId };
  } catch {
    return { allowed: false, topic: topicLabel, reason: "lookup_failed" };
  }
}

/**
 * Milliseconds until a JWT `exp` claim (seconds since epoch) is reached.
 * Returns null when the token has no expiry, and 0 or less when already expired.
 */
export function msUntilTokenExpiry(
  exp: unknown,
  now: number = Date.now(),
): number | null {
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return exp * 1000 - now;
}

/**
 * Schedules `onExpire` at the token's expiry. Returns the timer, or null when
 * the token has no expiry. An already-expired token fires on the next tick.
 */
export function scheduleTokenExpiry(
  exp: unknown,
  onExpire: () => void,
  now: number = Date.now(),
): ReturnType<typeof setTimeout> | null {
  const delay = msUntilTokenExpiry(exp, now);
  if (delay === null) return null;
  return setTimeout(onExpire, Math.max(0, delay));
}
