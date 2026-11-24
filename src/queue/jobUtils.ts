import crypto from "crypto";

/**
 * Deterministic job ID generation for payment-initiation deduplication (#2375).
 *
 * BullMQ already refuses to add a second job with a jobId that is currently
 * waiting/active/delayed for the same queue, so hashing the transfer's
 * identifying attributes into a stable jobId lets us reuse that behavior to
 * silently de-duplicate accidental double submissions (e.g. a user
 * double-clicking "Send") without any extra Redis bookkeeping.
 *
 * The timestamp is bucketed into a fixed-size window so that two distinct
 * transfers with the same attributes made far enough apart (e.g. the same
 * sender paying the same recipient the same amount an hour later) are not
 * treated as duplicates.
 */
export const DEDUP_WINDOW_MS = 60_000;

export interface PaymentDedupAttributes {
  sender: string;
  recipient: string;
  amount: string | number;
  currency: string;
  /** Defaults to `Date.now()`. Exposed for deterministic testing. */
  timestamp?: number;
}

/**
 * Buckets a timestamp into fixed-size windows of `windowMs` so that calls
 * made within the same window resolve to the same bucket index.
 */
export function getTimestampWindowBucket(
  timestamp: number,
  windowMs: number = DEDUP_WINDOW_MS,
): number {
  return Math.floor(timestamp / windowMs);
}

/**
 * Generates a deterministic BullMQ jobId for a payment initiation request,
 * derived from `hash(sender, recipient, amount, currency, timestamp_window)`.
 *
 * Two calls describing the same transfer within the same dedup window
 * produce the same jobId; the same transfer in a later window, or any
 * transfer with different sender/recipient/amount/currency, produces a
 * different jobId.
 */
export function generatePaymentDedupJobId(
  attrs: PaymentDedupAttributes,
  windowMs: number = DEDUP_WINDOW_MS,
): string {
  const bucket = getTimestampWindowBucket(
    attrs.timestamp ?? Date.now(),
    windowMs,
  );

  const canonical = [
    attrs.sender,
    attrs.recipient,
    String(attrs.amount),
    attrs.currency,
    String(bucket),
  ].join(":");

  const digest = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");

  return `payment-dedup-${digest}`;
}
