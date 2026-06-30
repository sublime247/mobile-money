/**
 * ValidationEngine Tests
 * Tests for input validation and error management
 */

import { ValidationEngine } from "../ValidationEngine";

describe("ValidationEngine", () => {
  describe("validateAmount", () => {
    it("should validate valid numeric amounts", () => {
      const result = ValidationEngine.validateAmount(100.5);
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe(100.5);
      expect(result.error).toBeUndefined();
    });

    it("should validate string numeric amounts", () => {
      const result = ValidationEngine.validateAmount("123.45");
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe(123.45);
    });

    it("should reject null and undefined", () => {
      expect(ValidationEngine.validateAmount(null).isValid).toBe(false);
      expect(ValidationEngine.validateAmount(undefined).isValid).toBe(false);
    });

    it("should reject NaN values", () => {
      const result = ValidationEngine.validateAmount(NaN);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("valid number");
    });

    it("should reject negative amounts", () => {
      const result = ValidationEngine.validateAmount(-10);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("negative");
    });

    it("should reject infinite values", () => {
      const result = ValidationEngine.validateAmount(Infinity);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("infinite");
    });
  });

  describe("validateCurrencyCode", () => {
    it("should validate supported currency codes", () => {
      const result = ValidationEngine.validateCurrencyCode("USD");
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe("USD");
    });

    it("should normalize currency codes to uppercase", () => {
      const result = ValidationEngine.validateCurrencyCode("usd");
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe("USD");
    });

    it("should reject unsupported currency codes", () => {
      const result = ValidationEngine.validateCurrencyCode("XXX");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Unsupported currency");
    });

    it("should reject invalid format", () => {
      const result = ValidationEngine.validateCurrencyCode("US");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("3 uppercase letters");
    });

    it("should reject null and undefined", () => {
      expect(ValidationEngine.validateCurrencyCode(null as any).isValid).toBe(
        false,
      );
      expect(
        ValidationEngine.validateCurrencyCode(undefined as any).isValid,
      ).toBe(false);
    });
  });

  describe("validateLocale", () => {
    it("should validate standard locales", () => {
      const result = ValidationEngine.validateLocale("en-US");
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe("en-US");
    });

    it("should validate language-only locales", () => {
      const result = ValidationEngine.validateLocale("en");
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe("en");
    });

    it("should reject invalid locale format", () => {
      const result = ValidationEngine.validateLocale("invalid-locale-format");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("format");
    });

    it("should provide fallback for unsupported locales", () => {
      const result = ValidationEngine.validateLocale("xx-XX");
      expect(result.isValid).toBe(true);
      // Should fallback to a supported locale
      expect(result.sanitizedValue).toBeDefined();
    });
  });

  describe("validateOptions", () => {
    it("should validate empty options", () => {
      const result = ValidationEngine.validateOptions({});
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toEqual({});
    });

    it("should validate null/undefined options", () => {
      expect(ValidationEngine.validateOptions(null).isValid).toBe(true);
      expect(ValidationEngine.validateOptions(undefined).isValid).toBe(true);
    });

    it("should validate valid options", () => {
      const options = {
        locale: "en-US",
        useGrouping: true,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        roundingMode: "round" as const,
      };
      const result = ValidationEngine.validateOptions(options);
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toMatchObject(options);
    });

    it("should reject invalid option types", () => {
      const result = ValidationEngine.validateOptions("invalid");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("object");
    });

    it("should reject invalid fraction digits", () => {
      const result = ValidationEngine.validateOptions({
        minimumFractionDigits: -1,
      });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("minimumFractionDigits");
    });
  });

  describe("validateAmountForCurrency", () => {
    it("should validate amount within currency limits", () => {
      const result = ValidationEngine.validateAmountForCurrency(100, "USD");
      expect(result.isValid).toBe(true);
      expect(result.sanitizedValue).toBe(100);
    });

    it("should reject amount exceeding currency precision", () => {
      // XAF has 0 decimal places
      const result = ValidationEngine.validateAmountForCurrency(100.5, "XAF");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("decimal places");
    });

    it("should reject amount exceeding maximum value", () => {
      const result = ValidationEngine.validateAmountForCurrency(
        9999999999999,
        "USD",
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("maximum allowed value");
    });
  });
});
