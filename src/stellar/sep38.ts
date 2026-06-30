import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";
import { rateProvider } from "../services/sep38/rateProvider";
import { SUPPORTED_CURRENCIES } from "../services/currency";

const router = Router();

// ─── Quote cache ────────────────────────────────────────────────────────────

const quoteCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TTL = 60;
const MAX_TTL = 300;
const MIN_TTL = 0;

const PRICE_PRECISION = 7;

// ─── Types ──────────────────────────────────────────────────────────────────

interface Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
  price: string;
  fee_percent: string;
  fee_fixed: string;
  created_at: string;
}

interface SupportedAssetPair {
  sell_asset: string;
  buy_asset: string;
}

// ─── Supported assets ───────────────────────────────────────────────────────

function getUsdcAssetId(): string {
  const issuer = process.env.SEP38_USDC_ISSUER
    || process.env.STELLAR_ASSET_ISSUER
    || "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  return `stellar:USDC:${issuer}`;
}

function buildSupportedPairs(): SupportedAssetPair[] {
  const pairs: SupportedAssetPair[] = [];
  const fiatCurrencies = [...SUPPORTED_CURRENCIES];

  for (let i = 0; i < fiatCurrencies.length; i++) {
    for (let j = 0; j < fiatCurrencies.length; j++) {
      if (i !== j) {
        pairs.push({
          sell_asset: `iso4217:${fiatCurrencies[i]}`,
          buy_asset: `iso4217:${fiatCurrencies[j]}`,
        });
      }
    }
  }

  pairs.push({ sell_asset: "stellar:XLM", buy_asset: "iso4217:USD" });
  pairs.push({ sell_asset: "iso4217:USD", buy_asset: "stellar:XLM" });

  for (const fiat of fiatCurrencies) {
    if (fiat !== "USD") {
      pairs.push({ sell_asset: "stellar:XLM", buy_asset: `iso4217:${fiat}` });
      pairs.push({ sell_asset: `iso4217:${fiat}`, buy_asset: "stellar:XLM" });
    }
  }

  const usdcId = getUsdcAssetId();
  pairs.push({ sell_asset: usdcId, buy_asset: "iso4217:USD" });
  pairs.push({ sell_asset: "iso4217:USD", buy_asset: usdcId });
  pairs.push({ sell_asset: "stellar:XLM", buy_asset: usdcId });
  pairs.push({ sell_asset: usdcId, buy_asset: "stellar:XLM" });

  return pairs;
}

const SUPPORTED_PAIRS = buildSupportedPairs();

// ─── Validation helpers ─────────────────────────────────────────────────────

function isValidAsset(asset: string): boolean {
  if (!asset || typeof asset !== "string") return false;
  if (asset === "stellar:native") return true;
  if (asset.startsWith("iso4217:")) return true;
  if (asset.startsWith("stellar:")) {
    const parts = asset.split(":");
    if (parts.length === 2 && parts[1] === "XLM") return true;
    if (parts.length === 3 && parts[1] && parts[2]) return true;
  }
  return false;
}

function isValidPositiveNumber(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  const num = parseFloat(value);
  return !isNaN(num) && isFinite(num) && num > 0;
}

function findSupportedPair(sellAsset: string, buyAsset: string): SupportedAssetPair | undefined {
  return SUPPORTED_PAIRS.find(
    (p) => p.sell_asset === sellAsset && p.buy_asset === buyAsset,
  );
}

// ─── Routes ─────────────────────────────────────────────────────────────────

router.get("/info", (_req: Request, res: Response) => {
  try {
    res.json({
      assets: SUPPORTED_PAIRS.map((p) => ({
        sell_asset: p.sell_asset,
        buy_asset: p.buy_asset,
      })),
    });
  } catch (err) {
    logger.error({ err }, "GET /sep38/info failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/prices", async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset } = req.query;

    if (!sell_asset || !buy_asset) {
      res.status(400).json({ error: "Missing required parameters: sell_asset and buy_asset" });
      return;
    }

    const sellAsset = sell_asset as string;
    const buyAsset = buy_asset as string;

    if (!isValidAsset(sellAsset) || !isValidAsset(buyAsset)) {
      res.status(400).json({
        error: "Invalid asset format. Assets must be in format 'stellar:*' or 'iso4217:*'",
      });
      return;
    }

    if (!findSupportedPair(sellAsset, buyAsset)) {
      res.status(400).json({ error: "Unsupported asset pair" });
      return;
    }

    const result = await rateProvider.getIndicativePrice(sellAsset, buyAsset);

    if (!result) {
      res.status(503).json({ error: "Insufficient liquidity for the requested asset pair" });
      return;
    }

    res.json({
      sell_asset: sellAsset,
      buy_asset: buyAsset,
      price: result.price,
      fee_percent: result.fee_percent,
      fee_fixed: result.fee_fixed,
    });
  } catch (err) {
    logger.error({ err }, "GET /sep38/prices failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/price", async (req: Request, res: Response) => {
  const { sell_asset, buy_asset } = req.query;

  if (!sell_asset || !buy_asset) {
    res.status(400).json({ error: "Missing required parameters: sell_asset and buy_asset" });
    return;
  }

  const sellAsset = sell_asset as string;
  const buyAsset = buy_asset as string;

  if (!isValidAsset(sellAsset) || !isValidAsset(buyAsset)) {
    res.status(400).json({
      error: "Invalid asset format. Assets must be in format 'stellar:*' or 'iso4217:*'",
    });
    return;
  }

  if (!findSupportedPair(sellAsset, buyAsset)) {
    res.status(400).json({ error: "Unsupported asset pair" });
    return;
  }

  const result = await rateProvider.getIndicativePrice(sellAsset, buyAsset);

  if (!result) {
    res.status(503).json({ error: "Insufficient liquidity for the requested asset pair" });
    return;
  }

  res.json({
    sell_asset: sellAsset,
    buy_asset: buyAsset,
    price: result.price,
    fee_percent: result.fee_percent,
    fee_fixed: result.fee_fixed,
  });
});

router.post("/quote", async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset, sell_amount, buy_amount, ttl } = req.body;

    if (!sell_asset || !buy_asset) {
      res.status(400).json({ error: "Missing required parameters: sell_asset and buy_asset" });
      return;
    }

    if (!sell_amount && !buy_amount) {
      res.status(400).json({
        error: "Missing required parameters: either sell_amount or buy_amount must be provided",
      });
      return;
    }

    if (!isValidAsset(sell_asset as string) || !isValidAsset(buy_asset as string)) {
      res.status(400).json({
        error: "Invalid asset format. Assets must be in format 'stellar:*' or 'iso4217:*'",
      });
      return;
    }

    const sellAsset = sell_asset as string;
    const buyAsset = buy_asset as string;

    if (!findSupportedPair(sellAsset, buyAsset)) {
      res.status(400).json({ error: "Unsupported asset pair" });
      return;
    }

    if (sell_amount && !isValidPositiveNumber(sell_amount)) {
      res.status(400).json({ error: "sell_amount must be a positive number" });
      return;
    }

    if (buy_amount && !isValidPositiveNumber(buy_amount)) {
      res.status(400).json({ error: "buy_amount must be a positive number" });
      return;
    }

    let quoteTTL = DEFAULT_TTL;
    if (ttl !== undefined && ttl !== null) {
      const ttlNum = parseInt(ttl, 10);
      if (!isNaN(ttlNum)) {
        if (ttlNum > 0) {
          quoteTTL = ttlNum > MAX_TTL ? MAX_TTL : ttlNum;
        } else {
          quoteTTL = DEFAULT_TTL;
        }
      }
    }

    const quoteResult = await rateProvider.getFirmPrice(sellAsset, buyAsset);

    if (!quoteResult) {
      res.status(503).json({ error: "Insufficient liquidity for the requested asset pair" });
      return;
    }

    const priceNum = parseFloat(quoteResult.price);
    let computedSellAmount: string;
    let computedBuyAmount: string;

    if (sell_amount) {
      computedSellAmount = parseFloat(sell_amount).toFixed(PRICE_PRECISION);
      computedBuyAmount = (parseFloat(sell_amount) * priceNum).toFixed(PRICE_PRECISION);
    } else {
      computedBuyAmount = parseFloat(buy_amount!).toFixed(PRICE_PRECISION);
      computedSellAmount = (parseFloat(buy_amount!) / priceNum).toFixed(PRICE_PRECISION);
    }

    const quoteId = uuidv4();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + quoteTTL * 1000).toISOString();

    const quote: Quote = {
      id: quoteId,
      expires_at: expiresAt,
      sell_asset: sellAsset,
      buy_asset: buyAsset,
      sell_amount: computedSellAmount,
      buy_amount: computedBuyAmount,
      price: quoteResult.price,
      fee_percent: quoteResult.fee_percent,
      fee_fixed: quoteResult.fee_fixed,
      created_at: createdAt,
    };

    quoteCache.set(quoteId, quote, quoteTTL);

    res.json(quote);
  } catch (err) {
    logger.error({ err }, "POST /sep38/quote failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/quote/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id || typeof id !== "string" || id.trim().length === 0) {
      res.status(400).json({ error: "Invalid quote ID" });
      return;
    }

    const quote = quoteCache.get<Quote>(id);

    if (!quote) {
      res.status(404).json({ error: "Quote not found" });
      return;
    }

    const now = new Date();
    const expiresAt = new Date(quote.expires_at);

    if (now >= expiresAt) {
      quoteCache.del(id);
      res.status(410).json({ error: "Quote has expired" });
      return;
    }

    res.json(quote);
  } catch (err) {
    logger.error({ err }, "GET /sep38/quote/:id failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
