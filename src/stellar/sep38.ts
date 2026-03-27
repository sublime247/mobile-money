import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";
import { currencyService, SupportedCurrency } from "../services/currency";

const router = Router();

// Cache for quotes with TTL support
const quoteCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Supported asset pairs configuration
interface AssetPair {
  sell_asset: string;
  buy_asset: string;
}

interface Price {
  sell_asset: string;
  buy_asset: string;
  price: string;
}

interface Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
  price: string;
  created_at: string;
}

// Supported asset pairs - can be configured via environment variables
const SUPPORTED_ASSET_PAIRS: AssetPair[] = [
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "iso4217:USD" },
  { sell_asset: "iso4217:USD", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { sell_asset: "stellar:XLM", buy_asset: "iso4217:USD" },
  { sell_asset: "iso4217:USD", buy_asset: "stellar:XLM" },
  { sell_asset: "stellar:XLM", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "stellar:XLM" },
];

// Exchange rate service - can be replaced with live service integration

// Exchange rate service - can be replaced with live service integration
class ExchangeRateService {
  private mapToCurrencyCode(asset: string): string | null {
    if (asset === "stellar:XLM") return "XLM";
    if (asset.startsWith("iso4217:")) return asset.split(":")[1];
    if (asset.startsWith("stellar:USDC:")) return "USD";
    return null;
  }

  async getPrice(sellAsset: string, buyAsset: string): Promise<string | null> {
    const sellCode = this.mapToCurrencyCode(sellAsset);
    const buyCode = this.mapToCurrencyCode(buyAsset);

    if (!sellCode || !buyCode) return null;

    let rate: number = 1.0;

    try {
      // Integrate with CurrencyService for live rates
      if (sellCode === "XLM" || buyCode === "XLM") {
        const xlmPriceUsd = 0.12; // Static placeholder for XLM price
        if (sellCode === "XLM" && buyCode === "USD") rate = xlmPriceUsd;
        else if (sellCode === "USD" && buyCode === "XLM") rate = 1 / xlmPriceUsd;
        else if (sellCode === "XLM") {
          const conversion = currencyService.convert(1, "USD", buyCode as SupportedCurrency);
          rate = xlmPriceUsd * conversion.rate;
        } else if (buyCode === "XLM") {
          const conversion = currencyService.convertToBase(1, sellCode as SupportedCurrency);
          rate = conversion.rate / xlmPriceUsd;
        }
      } else {
        rate = currencyService.convert(1, sellCode as SupportedCurrency, buyCode as SupportedCurrency).rate;
      }
    } catch (e) {
      return null;
    }

    // Add small variation to simulate dynamic market rates
    const variation = 1 + (Math.random() - 0.5) * 0.002;
    const adjustedRate = rate * variation;
    
    return adjustedRate.toFixed(7);
  }

  async getQuote(
    sellAsset: string,
    buyAsset: string,
    sellAmount?: string,
    buyAmount?: string
  ): Promise<{ sellAmount: string; buyAmount: string; price: string } | null> {
    const price = await this.getPrice(sellAsset, buyAsset);
    
    if (!price) {
      return null;
    }

    const priceNum = parseFloat(price);
    let sAmt: string = "";
    let bAmt: string = "";

    if (sellAmount) {
      sAmt = sellAmount;
      bAmt = (parseFloat(sellAmount) * priceNum).toFixed(7);
    } else if (buyAmount) {
      bAmt = buyAmount;
      sAmt = (parseFloat(buyAmount) / priceNum).toFixed(7);
    }

    return { sellAmount: sAmt, buyAmount: bAmt, price };
  }
}

const exchangeRateService = new ExchangeRateService();

// GET /info - List supported asset pairs
router.get("/info", (req: Request, res: Response) => {
  try {
    const info = {
      assets: SUPPORTED_ASSET_PAIRS.map(pair => ({
        sell_asset: pair.sell_asset,
        buy_asset: pair.buy_asset
      }))
    };
    res.json(info);
  } catch (error) {
    console.error("Error in /info endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /prices - Get current prices for asset pairs
router.get("/prices", async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset } = req.query;
    
    // Validate required parameters
    if (!sell_asset || !buy_asset) {
      return res.status(400).json({ 
        error: "Missing required parameters: sell_asset and buy_asset" 
      });
    }

    // Validate asset pair is supported
    const assetPair = SUPPORTED_ASSET_PAIRS.find(
      pair => pair.sell_asset === sell_asset && pair.buy_asset === buy_asset
    );

    if (!assetPair) {
      return res.status(400).json({ 
        error: "Unsupported asset pair" 
      });
    }

    const price = await exchangeRateService.getPrice(sell_asset as string, buy_asset as string);
    
    if (!price) {
      return res.status(500).json({ 
        error: "Unable to fetch price for asset pair" 
      });
    }

    const priceResponse: Price = {
      sell_asset: sell_asset as string,
      buy_asset: buy_asset as string,
      price
    };

    res.json(priceResponse);
  } catch (error) {
    console.error("Error in /prices endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /quote - Create a new quote
router.post("/quote", async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset, sell_amount, buy_amount, ttl } = req.body;

    // Validate required parameters
    if (!sell_asset || !buy_asset || (!sell_amount && !buy_amount)) {
      return res.status(400).json({ 
        error: "Missing required parameters: sell_asset, buy_asset, and either sell_amount or buy_amount" 
      });
    }

    // Validate asset pair is supported
    const assetPair = SUPPORTED_ASSET_PAIRS.find(
      pair => pair.sell_asset === sell_asset && pair.buy_asset === buy_asset
    );

    if (!assetPair) {
      return res.status(400).json({ 
        error: "Unsupported asset pair" 
      });
    }

    // Validate amounts are positive numbers
    if (sell_amount && parseFloat(sell_amount) <= 0) {
      return res.status(400).json({ 
        error: "sell_amount must be a positive number" 
      });
    }

    if (buy_amount && parseFloat(buy_amount) <= 0) {
      return res.status(400).json({ 
        error: "buy_amount must be a positive number" 
      });
    }

    // Get quote from exchange rate service
    const quoteData = await exchangeRateService.getQuote(
      sell_asset,
      buy_asset,
      sell_amount,
      buy_amount
    );

    if (!quoteData) {
      return res.status(500).json({ 
        error: "Unable to generate quote for asset pair" 
      });
    }

    // Calculate TTL (Time To Live) in seconds
    const defaultTTL = 60; // 1 minute default
    const quoteTTL = ttl && ttl > 0 ? (ttl > 300 ? 300 : ttl) : defaultTTL;

    // Generate quote ID and expiration time
    const quoteId = uuidv4();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + quoteTTL * 1000).toISOString();

    // Create quote object
    const quote: Quote = {
      id: quoteId,
      expires_at: expiresAt,
      sell_asset,
      buy_asset,
      sell_amount: quoteData.sellAmount,
      buy_amount: quoteData.buyAmount,
      price: quoteData.price,
      created_at: createdAt
    };

    // Cache the quote with TTL
    quoteCache.set(quoteId, quote, quoteTTL);

    res.json(quote);
  } catch (error) {
    console.error("Error in /quote endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /quote/:id - Get quote by ID
router.get("/quote/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const quote = quoteCache.get<Quote>(id);
    
    if (!quote) {
      return res.status(404).json({ error: "Quote not found" });
    }

    // Check if quote has expired
    const now = new Date();
    const expiresAt = new Date(quote.expires_at);
    
    if (now >= expiresAt) {
      // Remove expired quote from cache
      quoteCache.del(id);
      return res.status(410).json({ error: "Quote has expired" });
    }

    res.json(quote);
  } catch (error) {
    console.error("Error in /quote/:id endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
