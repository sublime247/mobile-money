import { Router, Request, Response } from "express";
import { sep38RateLimiter } from "../middleware/rateLimiter";
import { rateProvider, Sep38Fee } from "../services/sep38/rateProvider";
import { createQuote, getQuote } from "../services/sep38/quoteService";

const FEE_PRECISION = 7;

/**
 * Scales a per-1-unit SEP-38 fee breakdown by the actual sell amount of a
 * quote. `rateProvider` always returns fees expressed per 1 unit of
 * sell_asset (matching how `price` is also expressed), so a specific quote
 * for e.g. 1000 units needs its fee line items multiplied by 1000.
 */
function scaleFeeBreakdown(fee: Sep38Fee, sellAmount: string): Sep38Fee {
  const multiplier = parseFloat(sellAmount);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return fee;

  return {
    total: (parseFloat(fee.total) * multiplier).toFixed(FEE_PRECISION),
    asset: fee.asset,
    details: fee.details.map((detail) => ({
      ...detail,
      amount: (parseFloat(detail.amount) * multiplier).toFixed(FEE_PRECISION),
    })),
  };
}

/**
 * Rebuilds a SEP-38 fee breakdown from a persisted quote's flat
 * fee_percent/fee_fixed fields and its sell_amount. Used by GET /quote/:id,
 * which only has the quote record (not the live rateProvider result) to
 * work from.
 */
function feeBreakdownFromQuote(quote: {
  feePercent: string;
  feeFixed: string;
  sellAsset: string;
  sellAmount?: string;
}): Sep38Fee {
  const sellAmount = parseFloat(quote.sellAmount ?? "1");
  const multiplier =
    Number.isFinite(sellAmount) && sellAmount > 0 ? sellAmount : 1;
  const feeFixed = parseFloat(quote.feeFixed) || 0;
  const feePercentAmount =
    ((parseFloat(quote.feePercent) || 0) / 100) * multiplier;
  const feeFixedAmount = feeFixed * multiplier;

  const details = [];
  if (feeFixedAmount > 0) {
    details.push({
      name: "fixed_fee",
      amount: feeFixedAmount.toFixed(FEE_PRECISION),
      description: "Fixed anchor fee per transaction, in sell_asset units.",
    });
  }
  details.push({
    name: "percentage_fee",
    amount: feePercentAmount.toFixed(FEE_PRECISION),
    description: `${(parseFloat(quote.feePercent) || 0).toFixed(2)}% conversion fee, in sell_asset units.`,
  });

  return {
    total: (feeFixedAmount + feePercentAmount).toFixed(FEE_PRECISION),
    asset: quote.sellAsset,
    details,
  };
}

/**
 * SEP-38 — Quotes and Price Streams
 *
 * Endpoints:
 *   GET  /prices       — indicative price for a sell/buy asset pair
 *   POST /quote        — firm (locked) price quote booked in pending_execution
 *   GET  /quote/:id    — retrieve a booked quote by ID
 *
 * All endpoints are protected by the sep38RateLimiter (60 req/min per
 * authenticated client / IP) to prevent high-frequency scraping.
 *
 * Spec reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md
 */

const router = Router();

// ---------------------------------------------------------------------------
// GET /prices
// ---------------------------------------------------------------------------

/**
 * Returns an indicative (non-binding) exchange rate for the requested pair.
 *
 * Query parameters:
 *   sell_asset  {string} — SEP-38 asset identifier, e.g. "iso4217:XAF"
 *   buy_asset   {string} — SEP-38 asset identifier, e.g. "stellar:USDC:<issuer>"
 *
 * Response 200:
 *   {
 *     price:       string   // buy_asset units per 1 sell_asset unit
 *     fee_percent: string   // percentage fee (e.g. "0.50")
 *     fee_fixed:   string   // fixed fee in sell_asset units
 *     sell_asset:  string
 *     buy_asset:   string
 *     type:        "indicative"
 *   }
 */
router.get("/prices", sep38RateLimiter, async (req: Request, res: Response) => {
  const { sell_asset, buy_asset } = req.query as {
    sell_asset?: string;
    buy_asset?: string;
  };

  if (!sell_asset || !buy_asset) {
    return res.status(400).json({
      error: "Bad Request",
      message: "sell_asset and buy_asset query parameters are required",
    });
  }

  const result = await rateProvider.getIndicativePrice(sell_asset, buy_asset);

  if (!result) {
    return res.status(422).json({
      error: "Unprocessable Entity",
      message: `No rate available for the pair ${sell_asset} / ${buy_asset}`,
    });
  }

  return res.status(200).json({
    sell_asset,
    buy_asset,
    price: result.price,
    fee_percent: result.fee_percent,
    fee_fixed: result.fee_fixed,
    fee: result.fee,
    type: "indicative",
  });
});

// ---------------------------------------------------------------------------
// POST /quote
// ---------------------------------------------------------------------------

/**
 * Books a firm (binding) quote with locked exchange rate and pending_execution status.
 *
 * Body (JSON):
 *   sell_asset    {string} — SEP-38 asset identifier
 *   buy_asset     {string} — SEP-38 asset identifier
 *   sell_amount   {string} — Optional sell amount
 *   buy_amount    {string} — Optional buy amount
 *   expire_after  {string} — Optional ISO timestamp requesting expiration limit
 *   ttl           {number} — Optional quote TTL in seconds
 *
 * Response 200:
 *   {
 *     id:          string
 *     expires_at:  string (ISO 8601)
 *     price:       string
 *     total_price: string
 *     sell_asset:  string
 *     buy_asset:   string
 *     sell_amount: string
 *     buy_amount:  string
 *     fee_percent: string
 *     fee_fixed:   string
 *     status:      "pending_execution"
 *     type:        "firm"
 *   }
 */
router.post("/quote", sep38RateLimiter, async (req: Request, res: Response) => {
  const { sell_asset, buy_asset, sell_amount, buy_amount, expire_after, ttl } =
    req.body as {
      sell_asset?: string;
      buy_asset?: string;
      sell_amount?: string;
      buy_amount?: string;
      expire_after?: string;
      ttl?: number | string;
    };

  if (!sell_asset || !buy_asset) {
    return res.status(400).json({
      error: "Bad Request",
      message: "sell_asset and buy_asset are required in the request body",
    });
  }

  const result = await rateProvider.getFirmPrice(sell_asset, buy_asset);

  if (!result) {
    return res.status(422).json({
      error: "Unprocessable Entity",
      message: `No rate available for the pair ${sell_asset} / ${buy_asset}`,
    });
  }

  // Determine TTL in seconds
  let ttlSeconds = 300;
  if (ttl !== undefined && ttl !== null) {
    const parsed = parseInt(String(ttl), 10);
    if (!isNaN(parsed) && parsed > 0) ttlSeconds = parsed;
  } else if (expire_after) {
    const expDate = new Date(expire_after);
    if (!isNaN(expDate.getTime())) {
      const diffSeconds = Math.round((expDate.getTime() - Date.now()) / 1000);
      if (diffSeconds > 0) ttlSeconds = diffSeconds;
    }
  }

  // Calculate amounts if sell_amount or buy_amount provided
  let calculatedSellAmount = sell_amount;
  let calculatedBuyAmount = buy_amount;
  const priceNum = parseFloat(result.price);

  if (sell_amount && !buy_amount && !isNaN(priceNum)) {
    calculatedBuyAmount = (parseFloat(sell_amount) * priceNum).toFixed(7);
  } else if (buy_amount && !sell_amount && !isNaN(priceNum) && priceNum > 0) {
    calculatedSellAmount = (parseFloat(buy_amount) / priceNum).toFixed(7);
  }

  const ownerId =
    (req as any).jwtUser?.sub || (req as any).user?.id || req.ip || "anonymous";

  const quote = await createQuote({
    ownerId,
    sellAsset: sell_asset,
    buyAsset: buy_asset,
    price: result.price,
    feePercent: result.fee_percent,
    feeFixed: result.fee_fixed,
    sellAmount: calculatedSellAmount,
    buyAmount: calculatedBuyAmount,
    status: "pending_execution",
    ttlSeconds,
  });

  return res.status(200).json({
    id: quote.id,
    expires_at: quote.expiresAt.toISOString(),
    price: quote.price,
    total_price: quote.totalPrice || quote.price,
    sell_asset: quote.sellAsset,
    buy_asset: quote.buyAsset,
    sell_amount: quote.sellAmount,
    buy_amount: quote.buyAmount,
    fee_percent: quote.feePercent,
    fee_fixed: quote.feeFixed,
    fee: quote.sellAmount
      ? scaleFeeBreakdown(result.fee, quote.sellAmount)
      : result.fee,
    status: quote.status,
    created_at: quote.createdAt.toISOString(),
    type: "firm",
  });
});

// ---------------------------------------------------------------------------
// GET /quote/:id
// ---------------------------------------------------------------------------

/**
 * Retrieves an existing booked quote by ID. Returns 410 if expired.
 */
router.get(
  "/quote/:id",
  sep38RateLimiter,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || typeof id !== "string" || id.trim().length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Quote ID parameter is required",
      });
    }

    const quote = await getQuote(id);

    if (!quote) {
      return res.status(404).json({
        error: "Not Found",
        message: "Quote not found",
      });
    }

    const isExpired =
      quote.status === "expired" || new Date() >= new Date(quote.expiresAt);
    if (isExpired) {
      return res.status(410).json({
        error: "Gone",
        message: "Quote has expired",
      });
    }

    return res.status(200).json({
      id: quote.id,
      expires_at: quote.expiresAt.toISOString(),
      price: quote.price,
      total_price: quote.totalPrice || quote.price,
      sell_asset: quote.sellAsset,
      buy_asset: quote.buyAsset,
      sell_amount: quote.sellAmount,
      buy_amount: quote.buyAmount,
      fee_percent: quote.feePercent,
      fee_fixed: quote.feeFixed,
      fee: feeBreakdownFromQuote(quote),
      status: quote.status,
      created_at: quote.createdAt.toISOString(),
      type: "firm",
    });
  },
);

export default router;
