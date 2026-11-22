import { Sep38Service } from "../sep38Service";

describe("Sep38Service", () => {
  let service: Sep38Service;

  beforeEach(() => {
    service = new Sep38Service();
  });

  describe("Asset Validation & Parsing", () => {
    it("correctly identifies valid and invalid Stellar & ISO4217 assets", () => {
      expect(service.isValidAsset("stellar:native")).toBe(true);
      expect(service.isValidAsset("stellar:XLM")).toBe(true);
      expect(service.isValidAsset("iso4217:KES")).toBe(true);
      expect(service.isValidAsset("iso4217:XAF")).toBe(true);
      expect(service.isValidAsset("iso4217:NGN")).toBe(true);
      expect(service.isValidAsset("iso4217:XOF")).toBe(true);

      const usdc = service.getUsdcAssetId();
      expect(service.isValidAsset(usdc)).toBe(true);

      expect(service.isValidAsset("")).toBe(false);
      expect(service.isValidAsset("bitcoin:BTC")).toBe(false);
    });
  });

  describe("Indicative Pricing (SEP-38 /prices & /price)", () => {
    it("calculates indicative prices between Stellar stablecoins and African fiat currencies", async () => {
      const usdc = service.getUsdcAssetId();
      const priceDetails = await service.calculatePrice({
        sellAsset: usdc,
        buyAsset: "iso4217:KES",
        sellAmount: "100.0",
      });

      expect(priceDetails).not.toBeNull();
      expect(priceDetails?.price).toBeDefined();
      expect(parseFloat(priceDetails!.price)).toBeGreaterThan(100); // 1 USD ~ 129 KES
      expect(parseFloat(priceDetails!.sell_amount)).toBe(100.0);
      expect(parseFloat(priceDetails!.buy_amount)).toBeGreaterThan(10000);
      expect(parseFloat(priceDetails!.fee.total)).toBeGreaterThan(0); // fee incorporated
    });

    it("incorporates spread margin and fee deductions into calculations", async () => {
      const usdc = service.getUsdcAssetId();
      const rawRate = await service.getBaseExchangeRate("USD", "NGN");
      expect(rawRate).toBe(1540.0);

      const priceDetails = await service.calculatePrice({
        sellAsset: usdc,
        buyAsset: "iso4217:NGN",
        sellAmount: "10.0",
      });

      expect(priceDetails).not.toBeNull();
      // Adjusted rate should include spread deduction
      expect(parseFloat(priceDetails!.price)).toBeLessThan(1540.0);
      expect(priceDetails!.fee_percent).toBe("0.25");
      expect(parseFloat(priceDetails!.fee.total)).toBeCloseTo(0.025, 3);
    });

    it("returns a list of indicative prices for GET /prices", async () => {
      const usdc = service.getUsdcAssetId();
      const prices = await service.getPrices(usdc, "50.0", [
        "iso4217:KES",
        "iso4217:XAF",
        "iso4217:NGN",
      ]);

      expect(prices).toHaveLength(3);
      for (const p of prices) {
        expect(parseFloat(p.price)).toBeGreaterThan(0);
        expect(p.decimals).toBe(7);
      }
    });
  });

  describe("Firm Quotes with TTL & Redis/Memory Cache (SEP-38 /quote)", () => {
    it("creates a firm quote with TTL expiration timestamps and fee details", async () => {
      const usdc = service.getUsdcAssetId();
      const quote = await service.createQuote({
        sellAsset: usdc,
        buyAsset: "iso4217:XAF",
        sellAmount: "20.0",
        ttl: 120,
      });

      expect(quote.id).toBeDefined();
      expect(quote.sell_asset).toBe(usdc);
      expect(quote.buy_asset).toBe("iso4217:XAF");
      expect(parseFloat(quote.sell_amount)).toBe(20.0);
      expect(parseFloat(quote.buy_amount)).toBeGreaterThan(10000);
      expect(quote.fee.total).toBeDefined();

      const createdTime = new Date(quote.created_at).getTime();
      const expiresTime = new Date(quote.expires_at).getTime();
      expect(expiresTime - createdTime).toBe(120 * 1000);
    });

    it("correctly computes sell_amount when buy_amount is specified (reverse RFQ)", async () => {
      const usdc = service.getUsdcAssetId();
      const quote = await service.createQuote({
        sellAsset: usdc,
        buyAsset: "iso4217:KES",
        buyAmount: "12900.0", // ~100 USD
      });

      expect(parseFloat(quote.buy_amount)).toBe(12900.0);
      expect(parseFloat(quote.sell_amount)).toBeGreaterThan(95);
      expect(parseFloat(quote.sell_amount)).toBeLessThan(105);
    });

    it("retrieves an active quote by ID and detects expiration", async () => {
      const usdc = service.getUsdcAssetId();
      const quote = await service.createQuote({
        sellAsset: usdc,
        buyAsset: "iso4217:NGN",
        sellAmount: "10.0",
        ttl: 10,
      });

      const lookup = await service.getQuote(quote.id);
      expect(lookup.quote).toBeDefined();
      expect(lookup.quote?.id).toBe(quote.id);
      expect(lookup.expired).toBeUndefined();

      // Test non-existent quote
      const missing = await service.getQuote("non-existent-uuid");
      expect(missing.quote).toBeUndefined();
      expect(missing.expired).toBeUndefined();
    });
  });
});
