import {
  buildTransactionSmsBody,
  formatPhoneE164,
  SmsRateLimiter,
} from "../../src/services/sms";

describe("SMS service", () => {
  describe("formatPhoneE164", () => {
    it("normalizes Cameroon numbers with default region", () => {
      expect(formatPhoneE164("677123456", "CM")).toMatch(/^\+237/);
    });

    it("accepts existing E.164", () => {
      expect(formatPhoneE164("+14155552671", "US")).toBe("+14155552671");
    });
  });

  describe("buildTransactionSmsBody", () => {
    it("builds completed template", () => {
      const body = buildTransactionSmsBody({
        referenceNumber: "TXN-1",
        type: "deposit",
        amount: "100",
        provider: "mtn",
        kind: "transaction_completed",
      });
      expect(body).toContain("TXN-1");
      expect(body).toContain("completed");
    });

    it("builds failed template with optional error", () => {
      const body = buildTransactionSmsBody({
        referenceNumber: "TXN-2",
        type: "withdraw",
        amount: "50",
        provider: "orange",
        kind: "transaction_failed",
        errorMessage: "timeout",
      });
      expect(body).toContain("TXN-2");
      expect(body.toLowerCase()).toContain("could not");
    });

    it("builds localized template when locale is provided", () => {
      const body = buildTransactionSmsBody({
        referenceNumber: "TXN-3",
        type: "deposit",
        amount: "80",
        provider: "mtn",
        kind: "transaction_completed",
        locale: "fr",
      });

      expect(body).toContain("Votre depot");
      expect(body).toContain("TXN-3");
    });
  });

  describe("SmsRateLimiter", () => {
    it("allows up to max then blocks until window resets", () => {
      const limiter = new SmsRateLimiter(2, 60_000);
      expect(limiter.tryConsume("k1")).toBe(true);
      expect(limiter.tryConsume("k1")).toBe(true);
      expect(limiter.tryConsume("k1")).toBe(false);
      expect(limiter.tryConsume("k2")).toBe(true);
    });
  });
});
