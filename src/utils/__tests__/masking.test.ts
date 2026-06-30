import {
  maskPhoneNumber,
  maskEmail,
  maskStellarAddress,
  maskSensitiveData,
} from "../masking";

describe("Masking Utility", () => {
  describe("maskPhoneNumber", () => {
    it("should mask a full phone number in the requested format", () => {
      expect(maskPhoneNumber("+237677123456")).toBe("+237***56");
    });

    it("should handle shorter phone numbers", () => {
      expect(maskPhoneNumber("677123456")).toBe("6771***56");
    });

    it("should return the original if too short to mask", () => {
      expect(maskPhoneNumber("12345")).toBe("12345");
    });

    it("should return empty string for empty input", () => {
      expect(maskPhoneNumber("")).toBe("");
    });
  });

  describe("maskEmail", () => {
    it("should mask an email address", () => {
      expect(maskEmail("johndoe@example.com")).toBe("jo***@example.com");
    });

    it("should handle short local parts", () => {
      expect(maskEmail("a@example.com")).toBe("a***@example.com");
    });

    it("should return original if no domain", () => {
      expect(maskEmail("johndoe")).toBe("johndoe");
    });
  });

  describe("maskStellarAddress", () => {
    it("should mask a Stellar address", () => {
      const addr = "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1234";
      expect(maskStellarAddress(addr)).toBe("GBXX...1234");
    });

    it("should return original if too short", () => {
      expect(maskStellarAddress("ABCD")).toBe("ABCD");
    });
  });

  describe("maskSensitiveData", () => {
    it("should route to correct masking function", () => {
      expect(maskSensitiveData("+237677123456", "phone")).toBe("+237***56");
      expect(maskSensitiveData("johndoe@example.com", "email")).toBe(
        "jo***@example.com",
      );
      expect(
        maskSensitiveData("GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1234", "stellar"),
      ).toBe("GBXX...1234");
    });
  });
});
