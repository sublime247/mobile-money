/**
 * SEP-38: Firm Quote Booking Service
 * Resolves Issue #2122: Provides guaranteed rate locking with TTL expiration
 * for off-chain anchor asset conversions.
 */

export interface Sep38FirmQuote {
  id: string;
  sellAsset: string;
  buyAsset: string;
  sellAmount: number;
  buyAmount: number;
  price: number;
  feePercent: number;
  feeFixed: number;
  status: "pending_execution" | "executed" | "expired" | "canceled";
  createdAt: Date;
  expiresAt: Date;
}

export class Sep38FirmQuoteEngine {
  private quotes = new Map<string, Sep38FirmQuote>();

  createFirmQuote(params: {
    sellAsset: string;
    buyAsset: string;
    sellAmount: number;
    indicativeRate: number;
    spreadPercent?: number;
    ttlSeconds?: number;
  }): Sep38FirmQuote {
    const ttl = params.ttlSeconds ?? 300; // 5 minute default lock
    const spread = params.spreadPercent ?? 0.005; // 0.5% spread
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const lockedPrice = params.indicativeRate * (1 - spread);
    const buyAmount = parseFloat((params.sellAmount * lockedPrice).toFixed(4));
    const quoteId = `quote_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const quote: Sep38FirmQuote = {
      id: quoteId,
      sellAsset: params.sellAsset,
      buyAsset: params.buyAsset,
      sellAmount: params.sellAmount,
      buyAmount,
      price: lockedPrice,
      feePercent: spread * 100,
      feeFixed: 0,
      status: "pending_execution",
      createdAt: now,
      expiresAt,
    };

    this.quotes.set(quoteId, quote);
    return quote;
  }

  getQuote(id: string): { quote: Sep38FirmQuote | null; isExpired: boolean } {
    const quote = this.quotes.get(id);
    if (!quote) return { quote: null, isExpired: false };

    const isExpired =
      quote.status === "expired" || new Date() > quote.expiresAt;
    if (isExpired && quote.status === "pending_execution") {
      quote.status = "expired";
    }
    return { quote, isExpired };
  }

  executeQuote(id: string): { success: boolean; reason?: string } {
    const { quote, isExpired } = this.getQuote(id);
    if (!quote) return { success: false, reason: "NOT_FOUND" };
    if (isExpired) return { success: false, reason: "EXPIRED" };
    if (quote.status !== "pending_execution") {
      return { success: false, reason: `INVALID_STATUS_${quote.status}` };
    }

    quote.status = "executed";
    return { success: true };
  }

  runExpirationJob(currentTime: Date = new Date()): number {
    let expiredCount = 0;
    for (const quote of this.quotes.values()) {
      if (
        quote.status === "pending_execution" &&
        currentTime >= quote.expiresAt
      ) {
        quote.status = "expired";
        expiredCount++;
      }
    }
    return expiredCount;
  }
}
