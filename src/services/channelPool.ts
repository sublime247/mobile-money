/**
 * Stellar channel account pool
 *
 * Every Stellar transaction consumes its source account's next sequence
 * number, so concurrent payments from one account race each other and fail
 * with `tx_bad_seq`. Channel accounts avoid that: each transaction uses a
 * leased channel as its *transaction* source (the channel's sequence is
 * consumed and it pays the fee) while the payment operation's source stays
 * the issuer, whose balance actually moves.
 *
 * `ChannelAccountPool`:
 *   - Leases each channel to exactly one transaction at a time — within this
 *     process via a FIFO waiter queue, and across replicas via a
 *     {@link ChannelLeaseStore} (Redis `SET NX PX` in production).
 *   - Tracks each channel's sequence number in the lease store so the next
 *     holder, on any replica, builds on the right sequence without a Horizon
 *     round-trip. A `tx_bad_seq` or an unknown submission outcome drops the
 *     cached value so it is reloaded from Horizon.
 *   - Releases the channel as soon as the ledger has answered the submission.
 *   - Periodically tops channels back up from a funding account when their
 *     XLM balance falls below a minimum, so they can keep paying fees.
 *
 * Configured with `STELLAR_CHANNEL_POOL_ACCOUNTS`; see {@link getChannelPool}.
 * This is independent of the Postgres-backed pool in `src/stellar/pool.ts`
 * used by the high-throughput service; give each its own accounts.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { randomUUID } from "crypto";
import { redisClient } from "../config/redis";
import { getNetworkPassphrase, getStellarServer } from "../config/stellar";
import { isSequenceMismatchError } from "../stellar/pool";
import logger from "../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChannelAccountConfig {
  publicKey: string;
  secretKey: string;
}

/**
 * Cross-process coordination for channel leases and cached sequences.
 * Implementations must make `tryLease` atomic.
 */
export interface ChannelLeaseStore {
  /** Take the lease if free; `true` when `holder` now owns it. */
  tryLease(key: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Drop the lease, but only if `holder` still owns it. */
  release(key: string, holder: string): Promise<void>;
  getSequence(publicKey: string): Promise<string | null>;
  setSequence(publicKey: string, sequence: string): Promise<void>;
  clearSequence(publicKey: string): Promise<void>;
}

/** The subset of Horizon the pool needs (mockable in tests). */
export interface ChannelHorizon {
  loadAccount(publicKey: string): Promise<StellarSdk.Horizon.AccountResponse>;
  submitTransaction(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse>;
}

export interface ChannelLease {
  publicKey: string;
  keypair: StellarSdk.Keypair;
  /**
   * Account with the channel's current sequence. Pass it straight to
   * `TransactionBuilder`, which advances it by one on `build()`.
   */
  account: StellarSdk.Account;
}

export interface ChannelPoolOptions {
  accounts: ChannelAccountConfig[];
  horizon?: ChannelHorizon;
  leaseStore?: ChannelLeaseStore;
  networkPassphrase?: string;
  /** A lease auto-expires after this long if its holder dies (default 60 s). */
  leaseTtlMs?: number;
  /** Give up waiting for a free channel after this long (default 15 s). */
  acquireTimeoutMs?: number;
  /** How often to re-check channels leased by other replicas (default 50 ms). */
  pollIntervalMs?: number;
  /** Attempts per transaction when the sequence was stale (default 3). */
  maxSequenceRetries?: number;
  /** Account that tops up channels; replenishment is off without it. */
  funder?: StellarSdk.Keypair;
  /** Top up when a channel's XLM balance falls below this (default 5). */
  minBalanceXlm?: number;
  /** Refill to this balance (default 20). */
  targetBalanceXlm?: number;
}

export interface ChannelPoolStats {
  total: number;
  available: number;
  leased: number;
  waiting: number;
}

export interface ReplenishResult {
  publicKey: string;
  previousBalance: string;
  toppedUpBy: string;
}

export class ChannelPoolExhaustedError extends Error {
  constructor(timeoutMs: number) {
    super(`No channel account became available within ${timeoutMs}ms`);
    this.name = "ChannelPoolExhaustedError";
  }
}

// ─── Lease stores ─────────────────────────────────────────────────────────────

/** Single-process lease store. */
export class InMemoryChannelLeaseStore implements ChannelLeaseStore {
  private leases = new Map<string, { holder: string; expiresAt: number }>();
  private sequences = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  async tryLease(key: string, holder: string, ttlMs: number) {
    const current = this.leases.get(key);
    if (current && current.expiresAt > this.now()) return false;
    this.leases.set(key, { holder, expiresAt: this.now() + ttlMs });
    return true;
  }

  async release(key: string, holder: string) {
    if (this.leases.get(key)?.holder === holder) this.leases.delete(key);
  }

  async getSequence(publicKey: string) {
    return this.sequences.get(publicKey) ?? null;
  }

  async setSequence(publicKey: string, sequence: string) {
    this.sequences.set(publicKey, sequence);
  }

  async clearSequence(publicKey: string) {
    this.sequences.delete(publicKey);
  }
}

// Deletes the key only if it still holds our token, so an expired holder
// cannot release a lease another replica has since taken.
const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

const SEQUENCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Redis lease store for multi-replica deployments. Falls back to an
 * in-memory store while Redis is disconnected so a Redis outage degrades to
 * per-process leasing instead of halting payments.
 */
export class RedisChannelLeaseStore implements ChannelLeaseStore {
  private readonly fallback = new InMemoryChannelLeaseStore();

  constructor(private readonly prefix = "stellar:channel") {}

  private get online() {
    return Boolean(redisClient.isOpen);
  }

  async tryLease(key: string, holder: string, ttlMs: number) {
    if (!this.online) return this.fallback.tryLease(key, holder, ttlMs);
    const reply = await redisClient.set(`${this.prefix}:lease:${key}`, holder, {
      condition: "NX",
      expiration: { type: "PX", value: ttlMs },
    });
    return reply === "OK";
  }

  async release(key: string, holder: string) {
    if (!this.online) return this.fallback.release(key, holder);
    await redisClient.eval(RELEASE_IF_OWNER, {
      keys: [`${this.prefix}:lease:${key}`],
      arguments: [holder],
    });
  }

  async getSequence(publicKey: string) {
    if (!this.online) return this.fallback.getSequence(publicKey);
    const value = await redisClient.get(`${this.prefix}:seq:${publicKey}`);
    return value == null ? null : String(value);
  }

  async setSequence(publicKey: string, sequence: string) {
    if (!this.online) return this.fallback.setSequence(publicKey, sequence);
    await redisClient.set(`${this.prefix}:seq:${publicKey}`, sequence, {
      expiration: { type: "PX", value: SEQUENCE_TTL_MS },
    });
  }

  async clearSequence(publicKey: string) {
    if (!this.online) return this.fallback.clearSequence(publicKey);
    await redisClient.del(`${this.prefix}:seq:${publicKey}`);
  }
}

// ─── Pool ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const REPLENISH_LOCK_KEY = "replenisher";

interface Waiter {
  resolve: (publicKey: string) => void;
}

export class ChannelAccountPool {
  private readonly keypairs = new Map<string, StellarSdk.Keypair>();
  /** Channels not leased by this process, in round-robin order. */
  private readonly idle: string[] = [];
  private readonly waiters: Waiter[] = [];
  /** Lease token per channel held by this process. */
  private readonly holders = new Map<string, string>();
  private readonly horizon: ChannelHorizon;
  private readonly store: ChannelLeaseStore;
  private readonly networkPassphrase: string;
  private readonly leaseTtlMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxSequenceRetries: number;
  private readonly funder?: StellarSdk.Keypair;
  private readonly minBalanceXlm: number;
  private readonly targetBalanceXlm: number;
  private readonly instanceId = randomUUID();
  private replenishTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ChannelPoolOptions) {
    if (options.accounts.length === 0) {
      throw new Error("ChannelAccountPool needs at least one channel account");
    }

    for (const { publicKey, secretKey } of options.accounts) {
      const keypair = StellarSdk.Keypair.fromSecret(secretKey);
      if (keypair.publicKey() !== publicKey) {
        throw new Error(`Secret key does not match channel ${publicKey}`);
      }
      if (this.keypairs.has(publicKey)) {
        throw new Error(`Duplicate channel account ${publicKey}`);
      }
      this.keypairs.set(publicKey, keypair);
      this.idle.push(publicKey);
    }

    this.horizon = options.horizon ?? getStellarServer();
    this.store = options.leaseStore ?? new InMemoryChannelLeaseStore();
    this.networkPassphrase =
      options.networkPassphrase ?? getNetworkPassphrase();
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.maxSequenceRetries = options.maxSequenceRetries ?? 3;
    this.funder = options.funder;
    this.minBalanceXlm = options.minBalanceXlm ?? 5;
    this.targetBalanceXlm = options.targetBalanceXlm ?? 20;

    if (this.targetBalanceXlm <= this.minBalanceXlm) {
      throw new Error("targetBalanceXlm must be greater than minBalanceXlm");
    }
  }

  get publicKeys(): string[] {
    return [...this.keypairs.keys()];
  }

  getStats(): ChannelPoolStats {
    return {
      total: this.keypairs.size,
      available: this.idle.length,
      leased: this.holders.size,
      waiting: this.waiters.length,
    };
  }

  /**
   * Leases a channel, runs `submit` with it, and releases the channel once
   * `submit` settles (i.e. once the ledger has answered).
   *
   * `submit` must build its transaction from `lease.account`, sign it with
   * `lease.keypair` (plus any operation-source signers) and submit it. On
   * `tx_bad_seq` the sequence is reloaded and `submit` is re-run — safe,
   * because a bad-sequence transaction never reaches the ledger.
   */
  async withChannel<T>(
    submit: (lease: ChannelLease) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const publicKey = await this.acquire();
      let account: StellarSdk.Account;
      try {
        account = await this.loadSequence(publicKey);
      } catch (error) {
        await this.release(publicKey);
        throw error;
      }
      const startSequence = account.sequenceNumber();

      try {
        const result = await submit({
          publicKey,
          keypair: this.keypairs.get(publicKey)!,
          account,
        });
        await this.recordSequence(publicKey, account.sequenceNumber());
        return result;
      } catch (error) {
        // Unless nothing was built, the ledger may or may not have consumed
        // the sequence; drop the cache so the next holder reloads it.
        if (account.sequenceNumber() !== startSequence) {
          await this.forgetSequence(publicKey);
        }

        if (
          isSequenceMismatchError(error) &&
          attempt < this.maxSequenceRetries
        ) {
          logger.warn(
            { channel: publicKey, attempt },
            "[ChannelPool] tx_bad_seq, reloading sequence and retrying",
          );
          continue;
        }
        throw error;
      } finally {
        await this.release(publicKey);
      }
    }
  }

  /**
   * Tops up every channel whose XLM balance is below `minBalanceXlm` back to
   * `targetBalanceXlm`, in a single transaction from the funder. Only one
   * replica replenishes at a time.
   */
  async replenish(): Promise<ReplenishResult[]> {
    if (!this.funder) return [];

    const token = randomUUID();
    const locked = await this.store.tryLease(
      REPLENISH_LOCK_KEY,
      token,
      this.leaseTtlMs,
    );
    if (!locked) return [];

    try {
      const toppedUp: ReplenishResult[] = [];
      for (const publicKey of this.keypairs.keys()) {
        const balance = await this.nativeBalance(publicKey);
        if (balance >= this.minBalanceXlm) continue;
        toppedUp.push({
          publicKey,
          previousBalance: balance.toFixed(7),
          toppedUpBy: (this.targetBalanceXlm - balance).toFixed(7),
        });
      }
      if (toppedUp.length === 0) return [];

      const funderId = this.funder.publicKey();
      const funderAccount = new StellarSdk.Account(
        funderId,
        (await this.horizon.loadAccount(funderId)).sequenceNumber(),
      );
      const builder = new StellarSdk.TransactionBuilder(funderAccount, {
        fee: String(StellarSdk.BASE_FEE),
        networkPassphrase: this.networkPassphrase,
      });
      for (const { publicKey, toppedUpBy } of toppedUp) {
        builder.addOperation(
          StellarSdk.Operation.payment({
            destination: publicKey,
            asset: StellarSdk.Asset.native(),
            amount: toppedUpBy,
          }),
        );
      }
      const tx = builder.setTimeout(30).build();
      tx.sign(this.funder);
      await this.horizon.submitTransaction(tx);

      logger.info(
        { channels: toppedUp.map((t) => t.publicKey) },
        "[ChannelPool] Replenished channel XLM balances",
      );
      return toppedUp;
    } finally {
      await this.store.release(REPLENISH_LOCK_KEY, token);
    }
  }

  /** Runs {@link replenish} now and then every `intervalMs`. */
  startReplenisher(intervalMs: number): void {
    this.stopReplenisher();
    const run = () =>
      this.replenish().catch((error) =>
        logger.error({ err: error }, "[ChannelPool] Replenishment failed"),
      );
    void run();
    this.replenishTimer = setInterval(run, intervalMs);
    this.replenishTimer.unref?.();
  }

  stopReplenisher(): void {
    if (this.replenishTimer) {
      clearInterval(this.replenishTimer);
      this.replenishTimer = null;
    }
  }

  // ─── Leasing ────────────────────────────────────────────────────────────

  private async acquire(): Promise<string> {
    const deadline = Date.now() + this.acquireTimeoutMs;

    for (;;) {
      const publicKey = await this.tryAcquireIdle();
      if (publicKey) return publicKey;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ChannelPoolExhaustedError(this.acquireTimeoutMs);
      }

      if (this.idle.length === 0) {
        // Everything is leased by this process: wait for a local release.
        const handedOff = await this.waitForLocalRelease(remaining);
        if (handedOff && (await this.claimShared(handedOff))) return handedOff;
      } else {
        // Idle locally but leased by another replica: poll.
        await sleep(Math.min(this.pollIntervalMs, remaining));
      }
    }
  }

  /** Tries each locally idle channel once against the shared store. */
  private async tryAcquireIdle(): Promise<string | null> {
    const candidates = this.idle.length;
    for (let i = 0; i < candidates; i++) {
      const publicKey = this.idle.shift();
      if (!publicKey) break;
      // On failure claimShared re-queues it at the back.
      if (await this.claimShared(publicKey)) return publicKey;
    }
    return null;
  }

  private async claimShared(publicKey: string): Promise<boolean> {
    const token = `${this.instanceId}:${randomUUID()}`;
    let ok = false;
    try {
      ok = await this.store.tryLease(publicKey, token, this.leaseTtlMs);
    } catch (error) {
      logger.warn(
        { err: error, channel: publicKey },
        "[ChannelPool] Lease store error",
      );
    }
    if (ok) {
      this.holders.set(publicKey, token);
    } else if (!this.idle.includes(publicKey)) {
      this.idle.push(publicKey);
    }
    return ok;
  }

  private waitForLocalRelease(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (publicKey) => {
          clearTimeout(timer);
          resolve(publicKey);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private async release(publicKey: string): Promise<void> {
    const token = this.holders.get(publicKey);
    this.holders.delete(publicKey);
    if (token) {
      await this.store
        .release(publicKey, token)
        .catch((error) =>
          logger.warn(
            { err: error, channel: publicKey },
            "[ChannelPool] Failed to release shared lease",
          ),
        );
    }

    // Hand the channel straight to the oldest local waiter (FIFO) so a
    // queued caller is not starved by newcomers.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(publicKey);
    } else {
      this.idle.push(publicKey);
    }
  }

  // ─── Sequences & balances ─────────────────────────────────────────────

  private async loadSequence(publicKey: string): Promise<StellarSdk.Account> {
    const cached = await this.store.getSequence(publicKey).catch(() => null);
    if (cached) return new StellarSdk.Account(publicKey, cached);

    const loaded = await this.horizon.loadAccount(publicKey);
    return new StellarSdk.Account(publicKey, loaded.sequenceNumber());
  }

  private async recordSequence(publicKey: string, sequence: string) {
    await this.store
      .setSequence(publicKey, sequence)
      .catch((error) =>
        logger.warn(
          { err: error, channel: publicKey },
          "[ChannelPool] Failed to cache sequence",
        ),
      );
  }

  private async forgetSequence(publicKey: string) {
    await this.store.clearSequence(publicKey).catch(() => undefined);
  }

  private async nativeBalance(publicKey: string): Promise<number> {
    const account = await this.horizon.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === "native");
    return native ? Number(native.balance) : 0;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let defaultPool: ChannelAccountPool | null | undefined;

function parseAccounts(raw: string | undefined): ChannelAccountConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    logger.error(
      { err: error },
      "[ChannelPool] STELLAR_CHANNEL_POOL_ACCOUNTS is not valid JSON",
    );
    return [];
  }
}

/**
 * Returns the process-wide pool, or `null` when no channel accounts are
 * configured (callers then submit from the issuer directly).
 *
 * Environment:
 *   STELLAR_CHANNEL_POOL_ACCOUNTS    JSON `[{publicKey, secretKey}, ...]`
 *   CHANNEL_POOL_FUNDER_SECRET       funding account (default: issuer)
 *   CHANNEL_POOL_MIN_XLM             top-up threshold (default 5)
 *   CHANNEL_POOL_TARGET_XLM          top-up target (default 20)
 *   CHANNEL_POOL_REPLENISH_INTERVAL_MS  check interval (default 300000)
 */
export function getChannelPool(): ChannelAccountPool | null {
  if (defaultPool !== undefined) return defaultPool;

  const accounts = parseAccounts(process.env.STELLAR_CHANNEL_POOL_ACCOUNTS);
  if (accounts.length === 0) {
    defaultPool = null;
    return defaultPool;
  }

  const funderSecret =
    process.env.CHANNEL_POOL_FUNDER_SECRET?.trim() ||
    process.env.STELLAR_ISSUER_SECRET?.trim();

  defaultPool = new ChannelAccountPool({
    accounts,
    leaseStore: new RedisChannelLeaseStore(),
    funder: funderSecret
      ? StellarSdk.Keypair.fromSecret(funderSecret)
      : undefined,
    minBalanceXlm: Number(process.env.CHANNEL_POOL_MIN_XLM ?? 5),
    targetBalanceXlm: Number(process.env.CHANNEL_POOL_TARGET_XLM ?? 20),
  });
  defaultPool.startReplenisher(
    Number(process.env.CHANNEL_POOL_REPLENISH_INTERVAL_MS ?? 300_000),
  );
  logger.info(
    { channels: accounts.length },
    "[ChannelPool] Channel account pool enabled",
  );
  return defaultPool;
}

/** Test hook: forget the cached default pool. */
export function resetChannelPool(): void {
  defaultPool?.stopReplenisher();
  defaultPool = undefined;
}
