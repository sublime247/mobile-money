/**
 * SEP-38 Quote Service
 *
 * Manages the lifecycle of firm quotes:
 *   - createQuote  — persist a new active quote and reserve liquidity
 *   - cancelQuote  — verify ownership, transition to 'cancelled', release liquidity
 *   - expireQuotes — sweep expired active quotes (called by the scheduler)
 *
 * Liquidity reservation is tracked in the `reserved_amount` column so the
 * pool can reject new quotes when insufficient depth is available.
 * The actual liquidity pool is modelled as a lightweight Redis counter
 * (key: `sep38:pool:reserved`) backed by the DB for durability.
 */

import { v4 as uuidv4 } from "uuid";
import { queryRead, queryWrite } from "../../config/database";
import { redisClient } from "../../config/redis";
import { layeredCache } from "../layeredCache";
import logger from "../../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuoteStatus = "active" | "pending_execution" | "cancelled" | "expired";

export interface Sep38Quote {
  id: string;
  ownerId: string;
  sellAsset: string;
  buyAsset: string;
  price: string;
  totalPrice?: string;
  sellAmount?: string;
  buyAmount?: string;
  feePercent: string;
  feeFixed: string;
  reservedAmount: string;
  status: QuoteStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateQuoteParams {
  ownerId?: string;
  sellAsset: string;
  buyAsset: string;
  price: string;
  totalPrice?: string;
  sellAmount?: string;
  buyAmount?: string;
  feePercent?: string;
  feeFixed?: string;
  status?: QuoteStatus;
  /** Sell-side units to reserve in the liquidity pool. Defaults to 0. */
  reservedAmount?: string;
  /** Quote TTL in seconds. Defaults to SEP38_QUOTE_TTL_SECONDS env var or 300. */
  ttlSeconds?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default quote lifetime — 5 minutes, overrideable via env */
const DEFAULT_QUOTE_TTL_SECONDS = parseInt(
  process.env.SEP38_QUOTE_TTL_SECONDS || "300",
);

/** Redis key for the global reserved-liquidity counter (sell-side, decimal string) */
const POOL_RESERVED_KEY = "sep38:pool:reserved";

/** Cache key prefix for individual quotes */
const QUOTE_CACHE_PREFIX = "sep38:quote:";

/** In-memory store fallback for test environments or DB outages */
const inMemoryQuotes = new Map<string, Sep38Quote>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cacheKey(id: string): string {
  return `${QUOTE_CACHE_PREFIX}${id}`;
}

function rowToQuote(row: Record<string, any>): Sep38Quote {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sellAsset: row.sell_asset,
    buyAsset: row.buy_asset,
    price: String(row.price),
    totalPrice: row.total_price != null ? String(row.total_price) : undefined,
    sellAmount: row.sell_amount != null ? String(row.sell_amount) : undefined,
    buyAmount: row.buy_amount != null ? String(row.buy_amount) : undefined,
    feePercent: String(row.fee_percent),
    feeFixed: String(row.fee_fixed),
    reservedAmount: String(row.reserved_amount),
    status: row.status as QuoteStatus,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Liquidity pool helpers
// ---------------------------------------------------------------------------

/**
 * Atomically increment the global reserved-liquidity counter by `amount`.
 * Uses Redis INCRBYFLOAT; falls back to a no-op if Redis is unavailable.
 */
async function reserveLiquidity(amount: string): Promise<void> {
  if (!redisClient.isOpen) return;
  try {
    await redisClient.incrbyfloat(POOL_RESERVED_KEY, parseFloat(amount));
  } catch (err) {
    logger.warn({ err }, "[SEP38] Redis unavailable — liquidity reservation skipped");
  }
}

/**
 * Atomically decrement the global reserved-liquidity counter by `amount`.
 * Clamps the result at 0 to guard against counter drift.
 */
async function releaseLiquidity(amount: string): Promise<void> {
  if (!redisClient.isOpen) return;
  try {
    const next = parseFloat(String(await redisClient.incrbyfloat(
      POOL_RESERVED_KEY,
      -parseFloat(amount),
    )));
    // Clamp at zero — counter drift can produce tiny negatives
    if (next < 0) {
      await redisClient.set(POOL_RESERVED_KEY, "0");
    }
  } catch (err) {
    logger.warn({ err }, "[SEP38] Redis unavailable — liquidity release skipped");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a new firm quote and reserve the corresponding liquidity.
 */
export async function createQuote(params: CreateQuoteParams): Promise<Sep38Quote> {
  const {
    ownerId = "anonymous",
    sellAsset,
    buyAsset,
    price,
    totalPrice,
    sellAmount,
    buyAmount,
    feePercent = "0.0000",
    feeFixed = "0.0000000",
    status = "pending_execution",
    reservedAmount = "0",
    ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
  } = params;

  const id = uuidv4();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  let quote: Sep38Quote;
  if (process.env.NODE_ENV === "test" && !process.env.TEST_WITH_REAL_DB) {
    quote = {
      id,
      ownerId,
      sellAsset,
      buyAsset,
      price,
      totalPrice: totalPrice || price,
      sellAmount,
      buyAmount,
      feePercent,
      feeFixed,
      reservedAmount,
      status,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    inMemoryQuotes.set(id, quote);
  } else {
    try {
      const result = await queryWrite<Record<string, any>>(
        `INSERT INTO sep38_quotes
           (id, owner_id, sell_asset, buy_asset, price, total_price, sell_amount, buy_amount,
            fee_percent, fee_fixed, reserved_amount, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          id,
          ownerId,
          sellAsset,
          buyAsset,
          price,
          totalPrice || price,
          sellAmount || null,
          buyAmount || null,
          feePercent,
          feeFixed,
          reservedAmount,
          status,
          expiresAt,
        ],
      );
      quote = rowToQuote(result.rows[0]);
    } catch (err) {
      logger.warn({ err, id }, "[SEP38] DB write failed — storing quote in fallback memory store");
      quote = {
        id,
        ownerId,
        sellAsset,
        buyAsset,
        price,
        totalPrice: totalPrice || price,
        sellAmount,
        buyAmount,
        feePercent,
        feeFixed,
        reservedAmount,
        status,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryQuotes.set(id, quote);
    }
  }

  // Reserve liquidity in the pool counter
  await reserveLiquidity(reservedAmount);

  // Cache the quote for fast reads
  await layeredCache.set(cacheKey(id), quote, ttlSeconds);

  logger.info(
    { quoteId: id, ownerId, sellAsset, buyAsset, reservedAmount, status: quote.status },
    "[SEP38] Firm quote created",
  );

  return quote;
}

/**
 * Testing helper: retrieves raw in-memory quote reference for test fixtures.
 */
export function _getInMemoryQuote(id: string): Sep38Quote | undefined {
  return inMemoryQuotes.get(id);
}

/**
 * Look up a quote by ID, trying the cache first.
 */
export async function getQuote(id: string): Promise<Sep38Quote | null> {
  // 1. Cache hit
  const cached = await layeredCache.get<Sep38Quote>(cacheKey(id));
  if (cached) {
    const expiresAt =
      cached.expiresAt instanceof Date
        ? cached.expiresAt
        : new Date(cached.expiresAt);
    if (expiresAt < new Date()) {
      await layeredCache.del(cacheKey(id));
      if (
        cached.status === "active" ||
        cached.status === "pending_execution"
      ) {
        cached.status = "expired";
      }
    }
    return {
      ...cached,
      expiresAt,
      createdAt:
        cached.createdAt instanceof Date
          ? cached.createdAt
          : new Date(cached.createdAt),
      updatedAt:
        cached.updatedAt instanceof Date
          ? cached.updatedAt
          : new Date(cached.updatedAt),
    };
  }

  // 2. Test fallback
  if (process.env.NODE_ENV === "test" && !process.env.TEST_WITH_REAL_DB) {
    return inMemoryQuotes.get(id) || null;
  }

  // 3. DB read
  try {
    const result = await queryRead<Record<string, any>>(
      `SELECT * FROM sep38_quotes WHERE id = $1`,
      [id],
    );
    if (result.rows.length > 0) {
      const quote = rowToQuote(result.rows[0]);
      // Repopulate cache
      const remainingMs = quote.expiresAt.getTime() - Date.now();
      if (remainingMs > 0 && (quote.status === "active" || quote.status === "pending_execution")) {
        await layeredCache.set(cacheKey(id), quote, Math.ceil(remainingMs / 1000));
      }
      return quote;
    }
  } catch (err) {
    logger.warn({ err, id }, "[SEP38] DB read failed — checking fallback memory store");
  }

  // 4. Fallback memory store
  const memQuote = inMemoryQuotes.get(id);
  if (memQuote) {
    return memQuote;
  }

  return null;
}

/**
 * Cancel an active firm quote, releasing its reserved liquidity.
 *
 * Throws with a descriptive message on:
 *   - quote not found (404)
 *   - caller is not the owner (403)
 *   - quote is not active / pending_execution (409)
 */
export async function cancelQuote(
  id: string,
  requestingUserId: string,
): Promise<Sep38Quote> {
  // 1. Fetch the current state (cache-aware)
  const quote = await getQuote(id);

  if (!quote) {
    const err = new Error("Quote not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // 2. Ownership check
  if (quote.ownerId !== requestingUserId) {
    const err = new Error("Forbidden — you are not the owner of this quote") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }

  // 3. Status guard — only active or pending_execution quotes can be cancelled
  if (quote.status !== "active" && quote.status !== "pending_execution") {
    const err = new Error(
      `Quote cannot be cancelled: current status is '${quote.status}'`,
    ) as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

  // 4. Transition to 'cancelled' in Postgres or test memory store
  let cancelled: Sep38Quote;
  if (process.env.NODE_ENV === "test" && !process.env.TEST_WITH_REAL_DB) {
    const memQuote = inMemoryQuotes.get(id);
    if (memQuote && (memQuote.status === "active" || memQuote.status === "pending_execution")) {
      memQuote.status = "cancelled";
      memQuote.updatedAt = new Date();
      cancelled = memQuote;
    } else {
      const errObj = new Error(
        "Quote cannot be cancelled: it was already cancelled or expired",
      ) as Error & { statusCode: number };
      errObj.statusCode = 409;
      throw errObj;
    }
  } else {
    try {
      const result = await queryWrite<Record<string, any>>(
        `UPDATE sep38_quotes
         SET status = 'cancelled'
         WHERE id = $1 AND status IN ('active', 'pending_execution')
         RETURNING *`,
        [id],
      );

      if (result.rows.length === 0) {
        const err = new Error(
          "Quote cannot be cancelled: it was already cancelled or expired",
        ) as Error & { statusCode: number };
        err.statusCode = 409;
        throw err;
      }
      cancelled = rowToQuote(result.rows[0]);
    } catch (err: any) {
      if (err.statusCode) throw err;
      const memQuote = inMemoryQuotes.get(id);
      if (memQuote && (memQuote.status === "active" || memQuote.status === "pending_execution")) {
        memQuote.status = "cancelled";
        memQuote.updatedAt = new Date();
        cancelled = memQuote;
      } else {
        const errObj = new Error(
          "Quote cannot be cancelled: it was already cancelled or expired",
        ) as Error & { statusCode: number };
        errObj.statusCode = 409;
        throw errObj;
      }
    }
  }

  // 5. Release liquidity
  await releaseLiquidity(cancelled.reservedAmount);

  // 6. Invalidate the cache so subsequent reads reflect the new status
  await layeredCache.del(cacheKey(id));

  logger.info(
    { quoteId: id, ownerId: requestingUserId, releasedAmount: cancelled.reservedAmount },
    "[SEP38] Firm quote cancelled — liquidity released",
  );

  return cancelled;
}

/**
 * Sweep quotes whose expiry has passed.
 * Called by the scheduler; not exposed via HTTP.
 *
 * Returns the number of quotes expired.
 */
export async function expireStaleQuotes(): Promise<number> {
  let count = 0;
  if (process.env.NODE_ENV === "test" && !process.env.TEST_WITH_REAL_DB) {
    const now = new Date();
    for (const [id, q] of inMemoryQuotes.entries()) {
      if ((q.status === "active" || q.status === "pending_execution") && q.expiresAt < now) {
        q.status = "expired";
        await releaseLiquidity(q.reservedAmount);
        await layeredCache.del(cacheKey(id));
        count++;
      }
    }
  } else {
    try {
      const result = await queryWrite<Record<string, any>>(
        `UPDATE sep38_quotes
         SET status = 'expired'
         WHERE status IN ('active', 'pending_execution') AND expires_at < CURRENT_TIMESTAMP
         RETURNING id, reserved_amount`,
        [],
      );

      const rows = result.rows;
      count = rows.length;
      for (const row of rows) {
        await releaseLiquidity(String(row.reserved_amount));
        await layeredCache.del(cacheKey(row.id));
        inMemoryQuotes.delete(row.id);
      }
    } catch (err) {
      logger.warn({ err }, "[SEP38] DB sweep failed — sweeping fallback memory store");
      const now = new Date();
      for (const [id, q] of inMemoryQuotes.entries()) {
        if ((q.status === "active" || q.status === "pending_execution") && q.expiresAt < now) {
          q.status = "expired";
          await releaseLiquidity(q.reservedAmount);
          await layeredCache.del(cacheKey(id));
          count++;
        }
      }
    }
  }

  if (count > 0) {
    logger.info({ count }, "[SEP38] Expired stale quotes — liquidity released");
  }
  return count;
}

