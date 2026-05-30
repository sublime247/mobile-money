import { validatePhoneProviderMatch } from "../../src/utils/phoneUtils";

describe("phoneUtils", () => {
  describe("validatePhoneProviderMatch", () => {
    it("should return valid for a matching mtn number", () => {
      const result = validatePhoneProviderMatch("+237677123456", "mtn");
      expect(result.valid).toBe(true);
    });

    it("should return valid for a matching airtel number", () => {
      const result = validatePhoneProviderMatch("+256701234567", "airtel");
      expect(result.valid).toBe(true);
    });

    it("should return valid for a matching orange number", () => {
      const result = validatePhoneProviderMatch("+237651234567", "orange");
      expect(result.valid).toBe(true);
    });

    it("should return valid even if phone number does not start with +", () => {
      const result = validatePhoneProviderMatch("237677123456", "mtn");
      expect(result.valid).toBe(true);
    });

    it("should handle case-insensitive provider string", () => {
      const result = validatePhoneProviderMatch("+237677123456", "MTN");
      expect(result.valid).toBe(true);
    });

    it("should return invalid for an unsupported provider", () => {
      const result = validatePhoneProviderMatch("+237677123456", "unknown");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Unsupported provider: unknown");
    });

    it("should return invalid for a phone number that does not match the provider", () => {
      const result = validatePhoneProviderMatch("+256701234567", "mtn");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not belong to the MTN network");
    });
  });
});
