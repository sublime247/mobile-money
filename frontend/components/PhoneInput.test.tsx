/**
 * PhoneInput Component Tests (#2017)
 *
 * Acceptance Criteria verified:
 *   [✓] Automatically detect country flag (Cameroon, Senegal, Ivory Coast, Nigeria, Kenya, Ghana)
 *   [✓] Automatically format phone number according to country standard
 *   [✓] Display carrier badge (MTN MoMo, Orange Money, Airtel, M-Pesa, etc.) dynamically
 *   [✓] Highlight invalid prefix or incorrect digit length in real-time
 */

import {
  COUNTRIES,
  CARRIER_DEFINITIONS,
  CARRIER_PREFIX_MAP,
  detectCountry,
  detectCarrier,
  validatePhoneNumber,
} from "./PhoneInput";

describe("PhoneInput Component & Carrier Detection (#2017)", () => {
  describe("Country Detection", () => {
    it("detects Cameroon from +237 dial code", () => {
      const country = detectCountry("+237671234567");
      expect(country).toBeDefined();
      expect(country?.code).toBe("CM");
      expect(country?.flag).toBe("🇨🇲");
    });

    it("detects Senegal from +221 dial code", () => {
      const country = detectCountry("+221771234567");
      expect(country?.code).toBe("SN");
      expect(country?.flag).toBe("🇸🇳");
    });

    it("detects Ivory Coast from +225 dial code", () => {
      const country = detectCountry("+2250701020304");
      expect(country?.code).toBe("CI");
      expect(country?.flag).toBe("🇨🇮");
    });

    it("detects Nigeria from +234 dial code", () => {
      const country = detectCountry("+2348031234567");
      expect(country?.code).toBe("NG");
      expect(country?.flag).toBe("🇳🇬");
    });

    it("detects Kenya from +254 dial code", () => {
      const country = detectCountry("+254712345678");
      expect(country?.code).toBe("KE");
      expect(country?.flag).toBe("🇰🇪");
    });

    it("detects Ghana from +233 dial code", () => {
      const country = detectCountry("+233241234567");
      expect(country?.code).toBe("GH");
      expect(country?.flag).toBe("🇬🇭");
    });
  });

  describe("Carrier Detection", () => {
    it("detects MTN MoMo in Cameroon for prefix 67", () => {
      const carrier = detectCarrier("CM", "671234567");
      expect(carrier?.id).toBe("mtn");
      expect(carrier?.displayName).toBe("MTN MoMo");
    });

    it("detects Orange Money in Cameroon for prefix 69", () => {
      const carrier = detectCarrier("CM", "691234567");
      expect(carrier?.id).toBe("orange");
      expect(carrier?.displayName).toBe("Orange Money");
    });

    it("detects M-Pesa in Kenya for Safaricom prefix 712", () => {
      const carrier = detectCarrier("KE", "712345678");
      expect(carrier?.id).toBe("mpesa");
      expect(carrier?.displayName).toBe("M-Pesa");
    });

    it("detects Airtel Money in Kenya for prefix 733", () => {
      const carrier = detectCarrier("KE", "733123456");
      expect(carrier?.id).toBe("airtel");
      expect(carrier?.displayName).toBe("Airtel Money");
    });

    it("detects MTN in Nigeria for prefix 803", () => {
      const carrier = detectCarrier("NG", "8031234567");
      expect(carrier?.id).toBe("mtn");
    });

    it("detects Airtel in Nigeria for prefix 802", () => {
      const carrier = detectCarrier("NG", "8021234567");
      expect(carrier?.id).toBe("airtel");
    });

    it("detects Orange Money in Ivory Coast for prefix 07", () => {
      const carrier = detectCarrier("CI", "0701020304");
      expect(carrier?.id).toBe("orange");
    });

    it("detects MTN MoMo in Ghana for prefix 24", () => {
      const carrier = detectCarrier("GH", "241234567");
      expect(carrier?.id).toBe("mtn");
    });
  });

  describe("Validation & Formatting", () => {
    it("validates and formats valid Cameroon MTN number", () => {
      const result = validatePhoneNumber("671234567", COUNTRIES.CM);
      expect(result.isValid).toBe(true);
      expect(result.isPrefixValid).toBe(true);
      expect(result.isLengthValid).toBe(true);
      expect(result.carrier?.id).toBe("mtn");
      expect(result.formattedNumber).toBe("+237 671 23 45 67");
      expect(result.e164Number).toBe("+237671234567");
    });

    it("validates and formats valid Nigeria Airtel number with international prefix", () => {
      const result = validatePhoneNumber("+2348021234567");
      expect(result.isValid).toBe(true);
      expect(result.country?.code).toBe("NG");
      expect(result.carrier?.id).toBe("airtel");
      expect(result.formattedNumber).toBe("+234 802 123 4567");
      expect(result.e164Number).toBe("+2348021234567");
    });

    it("flags invalid carrier prefix in real-time", () => {
      const result = validatePhoneNumber("123456789", COUNTRIES.CM);
      expect(result.isValid).toBe(false);
      expect(result.isPrefixValid).toBe(false);
      expect(result.errorMessage).toContain("Invalid carrier prefix");
    });

    it("flags incorrect digit length in real-time", () => {
      const result = validatePhoneNumber("671234", COUNTRIES.CM); // only 6 digits
      expect(result.isValid).toBe(false);
      expect(result.isLengthValid).toBe(false);
      expect(result.errorMessage).toContain("incomplete");
    });

    it("flags number that is too long", () => {
      const result = validatePhoneNumber("671234567890", COUNTRIES.CM); // 12 digits
      expect(result.isValid).toBe(false);
      expect(result.isLengthValid).toBe(false);
      expect(result.errorMessage).toContain("too long");
    });
  });
});
