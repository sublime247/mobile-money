import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  CurrencyCode,
  findLatest,
  findNearest,
  findRange,
} from "../models/historicalPrice";
import { valueAtTime } from "../services/priceTicker";
import { TransactionModel } from "../models/transaction";

const transactionModel = new TransactionModel();

export const priceHistoryRoutes = Router();

const SUPPORTED = ["USD", "XLM", "XAF"] as const;
const currencyEnum = z.enum(SUPPORTED);

// ---------------------------------------------------------------------------
// GET /api/v1/prices/latest?base=XLM&quote=USD
// Returns the most recently recorded snapshot for a pair.
// ---------------------------------------------------------------------------

const latestQuerySchema = z.object({
  base: currencyEnum,
  quote: currencyEnum,
});

priceHistoryRoutes.get("/latest", async (req: Request, res: Response) => {
  const parsed = latestQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  const { base, quote } = parsed.data;
  if (base === quote) {
    return res
      .status(400)
      .json({ error: "base and quote must differ" });
  }

  try {
    const snapshot = await findLatest(base as CurrencyCode, quote as CurrencyCode);
    if (!snapshot) {
      return res.status(404).json({
        error: `No price data for ${base}/${quote}`,
      });
    }
    return res.json(snapshot);
  } catch (err) {
    logger.error("[priceHistory] /latest failed:", err);
    return res.status(500).json({ error: "Failed to fetch latest price" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/prices/history?base=XLM&quote=USD&from=ISO&to=ISO&limit=500
// Returns all snapshots in the range, oldest first.
// ---------------------------------------------------------------------------

const historyQuerySchema = z.object({
  base: currencyEnum,
  quote: currencyEnum,
  from: z.string().datetime({ message: "from must be ISO-8601 datetime" }),
  to: z.string().datetime({ message: "to must be ISO-8601 datetime" }),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

priceHistoryRoutes.get("/history", async (req: Request, res: Response) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  const { base, quote, from, to, limit } = parsed.data;
  if (base === quote) {
    return res.status(400).json({ error: "base and quote must differ" });
  }
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (fromDate > toDate) {
    return res
      .status(400)
      .json({ error: "from must be earlier than or equal to to" });
  }

  try {
    const rows = await findRange(
      base as CurrencyCode,
      quote as CurrencyCode,
      fromDate,
      toDate,
      limit ?? 1000,
    );
    return res.json({
      base,
      quote,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      count: rows.length,
      snapshots: rows,
    });
  } catch (err) {
    logger.error("[priceHistory] /history failed:", err);
    return res.status(500).json({ error: "Failed to fetch price history" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/prices/at?base=XLM&quote=USD&at=ISO&amount=100
// Returns the value of `amount` base at timestamp `at`, using the most
// recent snapshot recorded at or before `at`.
// ---------------------------------------------------------------------------

const atQuerySchema = z.object({
  base: currencyEnum,
  quote: currencyEnum,
  at: z.string().datetime({ message: "at must be ISO-8601 datetime" }),
  amount: z.coerce.number().positive().optional(),
});

priceHistoryRoutes.get("/at", async (req: Request, res: Response) => {
  const parsed = atQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  const { base, quote, at, amount } = parsed.data;
  const atDate = new Date(at);

  try {
    // Amount of 1 if not supplied so callers can use this as a "rate at T" lookup.
    const result = await valueAtTime(
      base as CurrencyCode,
      quote as CurrencyCode,
      amount ?? 1,
      atDate,
    );
    if (!result) {
      return res.status(404).json({
        error: `No price snapshot for ${base}/${quote} at or before ${atDate.toISOString()}`,
      });
    }
    return res.json(result);
  } catch (err) {
    logger.error("[priceHistory] /at failed:", err);
    return res.status(500).json({ error: "Failed to compute historical value" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/prices/transaction/:id/valuation?quote=USD
// Returns the value of the transaction amount in `quote` using the
// historical rate at the transaction's createdAt.
// ---------------------------------------------------------------------------

const valuationQuerySchema = z.object({
  quote: currencyEnum.optional(),
});

priceHistoryRoutes.get(
  "/transaction/:id/valuation",
  async (req: Request, res: Response) => {
    const parsed = valuationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }

    const quote = (parsed.data.quote as CurrencyCode | undefined) ?? "USD";
    const { id } = req.params;

    try {
      const tx = await transactionModel.findById(id);
      if (!tx) {
        return res.status(404).json({ error: "Transaction not found" });
      }

      // Transaction amounts are stored as DECIMAL strings; parse once here.
      const amount = parseFloat(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(422)
          .json({ error: "Transaction amount is not valuable (non-positive)" });
      }

      // Source currency: prefer tx.currency (set by the FX pipeline), fall
      // back to USD for legacy records without a currency stamp.
      const rawCurrency = (tx.currency ?? "USD").toUpperCase();
      if (!SUPPORTED.includes(rawCurrency as (typeof SUPPORTED)[number])) {
        return res.status(400).json({
          error: `Transaction currency ${rawCurrency} is not supported for historical valuation`,
        });
      }
      const base = rawCurrency as CurrencyCode;

      const at = new Date(tx.createdAt as unknown as string);
      const result = await valueAtTime(base, quote as CurrencyCode, amount, at);
      if (!result) {
        return res.status(404).json({
          error: `No price snapshot for ${base}/${quote} at or before ${at.toISOString()}`,
        });
      }

      return res.json({
        transactionId: tx.id,
        transactionCreatedAt: at.toISOString(),
        ...result,
      });
    } catch (err) {
      logger.error("[priceHistory] /transaction/:id/valuation failed:", err);
      return res
        .status(500)
        .json({ error: "Failed to compute transaction valuation" });
    }
  },
);
