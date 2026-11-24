/**
 * Timer logic for the SEP-38 quote countdown (#2039). Kept free of React so it
 * can be unit tested directly.
 */

/**
 * Difference (ms) between the server clock and the local clock. Compute it once
 * when the quote response arrives, from the server timestamp (e.g. the
 * response `Date` header) and `Date.now()` at receipt.
 */
export function computeClockOffset(
  serverTime: string | number | Date | undefined,
  receivedAt: number = Date.now(),
): number {
  if (serverTime === undefined) return 0;
  const server = new Date(serverTime).getTime();
  return Number.isNaN(server) ? 0 : server - receivedAt;
}

/** Whole seconds left before `expiresAt`, corrected for clock drift. Never negative. */
export function secondsRemaining(
  expiresAt: string | number | Date,
  clockOffsetMs = 0,
  now: number = Date.now(),
): number {
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return 0;
  return Math.max(0, Math.ceil((expiry - (now + clockOffsetMs)) / 1000));
}

export interface CountdownOptions {
  expiresAt: string | number | Date;
  clockOffsetMs?: number;
  onTick: (secondsLeft: number) => void;
  onExpire: () => void;
}

/** Ticks once per second; calls `onExpire` exactly once. Returns a stop function. */
export function startCountdown(opts: CountdownOptions): () => void {
  let expired = false;
  const tick = () => {
    const left = secondsRemaining(opts.expiresAt, opts.clockOffsetMs);
    opts.onTick(left);
    if (left <= 0 && !expired) {
      expired = true;
      clearInterval(id);
      opts.onExpire();
    }
  };
  const id = setInterval(tick, 1000);
  tick();
  return () => clearInterval(id);
}
