import { maskPhoneNumber, maskEmail, maskStellarAddress, maskSensitiveData } from "../../src/utils/masking";

describe("masking utils", () => {
  describe("maskPhoneNumber", () => {
    it("should mask a standard phone number", () => {
      expect(maskPhoneNumber("+237677123456")).toBe("+237***56");
    });
    
    it("should handle an empty string", () => {
      expect(maskPhoneNumber("")).toBe("");
    });
    
    it("should not mask a phone number of length 6 or less", () => {
      expect(maskPhoneNumber("123456")).toBe("123456");
    });
    
    it("should trim the phone number before masking", () => {
      expect(maskPhoneNumber(" +237677123456 ")).toBe("+237***56");
    });
  });

  describe("maskEmail", () => {
    it("should mask a standard email", () => {
      expect(maskEmail("johndoe@example.com")).toBe("jo***@example.com");
    });

    it("should handle an empty string", () => {
      expect(maskEmail("")).toBe("");
    });

    it("should return the email if it doesn't contain an @ symbol", () => {
      expect(maskEmail("invalidemail")).toBe("invalidemail");
    });

    it("should mask short local parts properly", () => {
      expect(maskEmail("me@example.com")).toBe("me***@example.com");
      expect(maskEmail("a@example.com")).toBe("a***@example.com");
    });
  });

  describe("maskStellarAddress", () => {
    it("should mask a standard stellar address", () => {
      const address = "GBAR4321ABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX";
      expect(maskStellarAddress(address)).toBe("GBAR...UVWX");
    });

    it("should handle an empty string", () => {
      expect(maskStellarAddress("")).toBe("");
    });

    it("should not mask if length is 8 or less", () => {
      expect(maskStellarAddress("12345678")).toBe("12345678");
    });
  });

  describe("maskSensitiveData", () => {
    it("should mask phone numbers", () => {
      expect(maskSensitiveData("+237677123456", "phone")).toBe("+237***56");
    });

    it("should mask emails", () => {
      expect(maskSensitiveData("johndoe@example.com", "email")).toBe("jo***@example.com");
    });

    it("should mask stellar addresses", () => {
      const address = "GBAR4321ABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX";
      expect(maskSensitiveData(address, "stellar")).toBe("GBAR...UVWX");
    });

    it("should return data as-is if type is unknown", () => {
      // @ts-expect-error Testing invalid type
      expect(maskSensitiveData("somedata", "unknown")).toBe("somedata");
    });

    it("should handle empty string", () => {
      expect(maskSensitiveData("", "phone")).toBe("");
    });
  });
});
