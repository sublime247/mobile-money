import { Sep38FirmQuoteEngine } from "../../src/services/sep38QuoteService";
import { ExpireQuotesJob } from "../../src/jobs/expireQuotesJob";

describe("SEP-38 Firm Quote Booking and Expiration (Issue #2122)", () => {
  let engine: Sep38FirmQuoteEngine;

  beforeEach(() => {
    engine = new Sep38FirmQuoteEngine();
  });

  it("should create firm quote with locked price, amounts, and 300s expiration", () => {
    const quote = engine.createFirmQuote({
      sellAsset: "iso4217:USD",
      buyAsset: "iso4217:KES",
      sellAmount: 100,
      indicativeRate: 130.0,
      spreadPercent: 0.01,
      ttlSeconds: 300,
    });

    expect(quote.id).toMatch(/^quote_/);
    expect(quote.status).toBe("pending_execution");
    expect(quote.price).toBe(128.7); // 130 * 0.99
    expect(quote.buyAmount).toBe(12870.0);
    expect(quote.expiresAt.getTime() - quote.createdAt.getTime()).toBe(
      300 * 1000,
    );
  });

  it("should allow execution of active quote within expiration window", () => {
    const quote = engine.createFirmQuote({
      sellAsset: "iso4217:EUR",
      buyAsset: "iso4217:XOF",
      sellAmount: 50,
      indicativeRate: 655.95,
      ttlSeconds: 60,
    });

    const execResult = engine.executeQuote(quote.id);
    expect(execResult.success).toBe(true);

    const retrieved = engine.getQuote(quote.id);
    expect(retrieved.quote?.status).toBe("executed");
  });

  it("should reject execution of expired quote and run expiration sweep job", () => {
    const quote = engine.createFirmQuote({
      sellAsset: "iso4217:USD",
      buyAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sellAmount: 200,
      indicativeRate: 1.0,
      ttlSeconds: 10,
    });

    const job = new ExpireQuotesJob(engine);
    const futureTime = new Date(Date.now() + 15 * 1000);
    const expiredCount = job.run(futureTime);
    expect(expiredCount).toBe(1);

    const execResult = engine.executeQuote(quote.id);
    expect(execResult.success).toBe(false);
    expect(execResult.reason).toBe("EXPIRED");
  });
});
