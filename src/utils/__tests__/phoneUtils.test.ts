import {
  formatPhoneForProvider,
  formatPhoneNumber,
  validatePhoneNumber,
  isValidPhoneNumber,
  parseFlexiblePhoneNumber,
  detectProvider,
  validatePhoneProviderMatch,
  normalizeCemacWaemuE164,
  PROVIDER_PREFIXES,
  PROVIDER_PHONE_FORMATS,
  CEMAC_WAEMU_REGIONS,
} from "../phoneUtils";

describe("phoneUtils", () => {
  describe("formatPhoneForProvider", () => {
    it("normalizes Airtel Cameroon numbers to national format", () => {
      expect(formatPhoneForProvider("+237670000000", "airtel")).toBe(
        "670000000",
      );
      expect(formatPhoneForProvider("237670000000", "airtel")).toBe(
        "670000000",
      );
      expect(formatPhoneForProvider("670000000", "airtel")).toBe("670000000");
    });

    it("keeps E.164 format for other providers", () => {
      expect(formatPhoneForProvider("+237670000000", "mtn")).toBe(
        "+237670000000",
      );
      expect(formatPhoneForProvider("+237650000000", "orange")).toBe(
        "+237650000000",
      );
      expect(formatPhoneForProvider("+255740000000", "vodacom")).toBe(
        "+255740000000",
      );
      expect(formatPhoneForProvider("+255713000000", "tigo")).toBe(
        "+255713000000",
      );
    });

    it("handles whitespace and special formatting characters", () => {
      expect(formatPhoneForProvider("+237 670 000 000", "mtn")).toBe(
        "+237670000000",
      );
      expect(formatPhoneForProvider("+237-670-00-00-00", "airtel")).toBe(
        "670000000",
      );
    });

    it("throws error for unsupported provider", () => {
      expect(() =>
        formatPhoneForProvider("+237670000000", "invalid_provider"),
      ).toThrow(/Unsupported provider/);
    });

    it("throws error for completely invalid phone number", () => {
      expect(() => formatPhoneForProvider("invalid_phone", "mtn")).toThrow(
        /Invalid phone number/,
      );
    });
  });

  describe("parseFlexiblePhoneNumber", () => {
    it("parses valid numbers with international plus", () => {
      const parsed = parseFlexiblePhoneNumber("+237670000000", "CM");
      expect(parsed).not.toBeNull();
      expect(parsed?.isValid()).toBe(true);
      expect(parsed?.countryCallingCode).toBe("237");
    });

    it("parses valid numbers without plus prefix", () => {
      const parsed = parseFlexiblePhoneNumber("237670000000", "CM");
      expect(parsed).not.toBeNull();
      expect(parsed?.isValid()).toBe(true);
      expect(parsed?.number).toBe("+237670000000");
    });

    it("parses valid numbers with double zero prefix (00)", () => {
      const parsed = parseFlexiblePhoneNumber("00237670000000", "CM");
      expect(parsed).not.toBeNull();
      expect(parsed?.isValid()).toBe(true);
      expect(parsed?.number).toBe("+237670000000");
    });

    it("returns null for non-string or empty input", () => {
      expect(parseFlexiblePhoneNumber("")).toBeNull();
      expect(parseFlexiblePhoneNumber("   ")).toBeNull();
      expect(parseFlexiblePhoneNumber("abc")).toBeNull();
      expect(parseFlexiblePhoneNumber(null as any)).toBeNull();
    });
  });

  describe("validatePhoneNumber", () => {
    it("returns valid info for valid phone number", () => {
      const info = validatePhoneNumber("+237670000000", "CM");
      expect(info.isValid).toBe(true);
      expect(info.countryCallingCode).toBe("237");
      expect(info.country).toBe("CM");
      expect(info.e164).toBe("+237670000000");
      expect(info.nationalNumber).toBe("670000000");
      expect(info.international).toBeDefined();
      expect(info.national).toBeDefined();
      expect(info.rfc3966).toContain("tel:+237670000000");
    });

    it("returns isValid false for invalid phone number", () => {
      const info = validatePhoneNumber("+999999999999999");
      expect(info.isValid).toBe(false);
      expect(info.e164).toBeUndefined();
    });
  });

  describe("isValidPhoneNumber", () => {
    it("returns true for valid phone numbers", () => {
      expect(isValidPhoneNumber("+237670000000", "CM")).toBe(true);
      expect(isValidPhoneNumber("+256701234567", "UG")).toBe(true);
      expect(isValidPhoneNumber("+233241234567", "GH")).toBe(true);
      expect(isValidPhoneNumber("+255740000000", "TZ")).toBe(true);
    });

    it("returns false for invalid numbers", () => {
      expect(isValidPhoneNumber("123")).toBe(false);
      expect(isValidPhoneNumber("not-a-number")).toBe(false);
      expect(isValidPhoneNumber("")).toBe(false);
    });
  });

  describe("formatPhoneNumber", () => {
    it("formats to E.164", () => {
      expect(formatPhoneNumber("670000000", "e164", "CM")).toBe(
        "+237670000000",
      );
    });

    it("formats to national", () => {
      const result = formatPhoneNumber("+237670000000", "national", "CM");
      expect(result.replace(/\s+/g, "")).toBe("670000000");
    });

    it("formats to international", () => {
      const result = formatPhoneNumber("+237670000000", "international", "CM");
      expect(result).toContain("+237");
    });

    it("formats to RFC3966", () => {
      const result = formatPhoneNumber("+237670000000", "rfc3966", "CM");
      expect(result).toBe("tel:+237670000000");
    });

    it("throws on invalid phone number", () => {
      expect(() => formatPhoneNumber("invalid", "e164")).toThrow(
        /Invalid phone number/,
      );
    });
  });

  describe("detectProvider", () => {
    it("detects MTN from prefix", () => {
      expect(detectProvider("+237670000000")).toBe("mtn");
      expect(detectProvider("+256770000000")).toBe("mtn");
      expect(detectProvider("233240000000")).toBe("mtn");
    });

    it("detects Airtel from prefix", () => {
      expect(detectProvider("+237660000000")).toBe("airtel");
      expect(detectProvider("+256700000000")).toBe("airtel");
    });

    it("detects Orange from prefix", () => {
      expect(detectProvider("+237650000000")).toBe("orange");
      expect(detectProvider("+22507000000")).toBe("orange");
    });

    it("detects Vodacom from prefix", () => {
      expect(detectProvider("+255740000000")).toBe("vodacom");
      expect(detectProvider("+255762000000")).toBe("vodacom");
    });

    it("detects Tigo from prefix", () => {
      expect(detectProvider("+255713000000")).toBe("tigo");
      expect(detectProvider("+255752000000")).toBe("tigo");
    });

    it("returns null for unknown prefix", () => {
      expect(detectProvider("+14155552671")).toBeNull();
      expect(detectProvider("")).toBeNull();
      expect(detectProvider(null as any)).toBeNull();
    });
  });

  describe("validatePhoneProviderMatch", () => {
    it("validates MTN prefix match", () => {
      expect(validatePhoneProviderMatch("+237670000000", "mtn").valid).toBe(
        true,
      );
      expect(validatePhoneProviderMatch("+237680000000", "MTN").valid).toBe(
        true,
      );
    });

    it("validates Airtel prefix match", () => {
      expect(validatePhoneProviderMatch("+237660000000", "airtel").valid).toBe(
        true,
      );
      expect(validatePhoneProviderMatch("+256700000000", "AIRTEL").valid).toBe(
        true,
      );
    });

    it("validates Orange prefix match", () => {
      expect(validatePhoneProviderMatch("+237650000000", "orange").valid).toBe(
        true,
      );
    });

    it("validates Vodacom prefix match", () => {
      expect(validatePhoneProviderMatch("+255740000000", "vodacom").valid).toBe(
        true,
      );
    });

    it("validates Tigo prefix match", () => {
      expect(validatePhoneProviderMatch("+255713000000", "tigo").valid).toBe(
        true,
      );
    });

    it("returns invalid for mismatched provider", () => {
      const res = validatePhoneProviderMatch("+237670000000", "airtel");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("does not belong to the AIRTEL network");
    });

    it("validates local phone numbers with country prefix overrides", () => {
      // Uganda MTN local number with country override
      expect(validatePhoneProviderMatch("0770000000", "mtn", "UG").valid).toBe(
        true,
      );

      // Ghana MTN local number with country override
      expect(validatePhoneProviderMatch("0240000000", "mtn", "GH").valid).toBe(
        true,
      );

      // Uganda Airtel local number with country override
      expect(
        validatePhoneProviderMatch("0700000000", "airtel", "UG").valid,
      ).toBe(true);

      // Tanzania Vodacom local number with country override
      expect(
        validatePhoneProviderMatch("0740000000", "vodacom", "TZ").valid,
      ).toBe(true);

      // Cameroon MTN local number
      expect(validatePhoneProviderMatch("670000000", "mtn", "CM").valid).toBe(
        true,
      );
    });

    it("returns invalid for unsupported provider or empty input", () => {
      expect(validatePhoneProviderMatch("+237670000000", "unknown").valid).toBe(
        false,
      );
      expect(validatePhoneProviderMatch("", "mtn").valid).toBe(false);
      expect(validatePhoneProviderMatch("+237670000000", "").valid).toBe(false);
    });
  });

  describe("detectProvider with countryOverride", () => {
    it("detects provider from local number with country override", () => {
      expect(detectProvider("0770000000", "UG")).toBe("mtn");
      expect(detectProvider("0700000000", "UG")).toBe("airtel");
      expect(detectProvider("0240000000", "GH")).toBe("mtn");
      expect(detectProvider("0740000000", "TZ")).toBe("vodacom");
      expect(detectProvider("670000000", "CM")).toBe("mtn");
    });
  });

  describe("formatPhoneForProvider with countryOverride", () => {
    it("formats local number with country override", () => {
      expect(formatPhoneForProvider("0770000000", "mtn", "UG")).toBe(
        "+256770000000",
      );
      expect(formatPhoneForProvider("0700000000", "airtel", "UG")).toBe(
        "700000000",
      );
      expect(formatPhoneForProvider("0240000000", "mtn", "GH")).toBe(
        "+233240000000",
      );
    });
  });

  describe("normalizeCemacWaemuE164 (#1963)", () => {
    it("strips whitespace, dashes, and local leading zero for each supported region", () => {
      expect(normalizeCemacWaemuE164("+237 670 000 000", "CM")).toBe(
        "+237670000000",
      );
      expect(normalizeCemacWaemuE164("+221-77-000-00-00", "SN")).toBe(
        "+221770000000",
      );
      expect(normalizeCemacWaemuE164("0707000000", "CI")).toBe(
        "+2250707000000",
      );
      expect(normalizeCemacWaemuE164("08031234567", "NG")).toBe(
        "+2348031234567",
      );
      expect(normalizeCemacWaemuE164("0712345678", "KE")).toBe("+254712345678");
      expect(normalizeCemacWaemuE164("0240000000", "GH")).toBe("+233240000000");
    });

    it("returns the E.164 string unchanged when already normalized", () => {
      for (const [input, region] of [
        ["+237670000000", "CM"],
        ["+221770000000", "SN"],
        ["+2250707000000", "CI"],
        ["+2348031234567", "NG"],
        ["+254712345678", "KE"],
        ["+233241234567", "GH"],
      ] as const) {
        expect(normalizeCemacWaemuE164(input, region)).toBe(input);
      }
    });

    it("throws for a number that is invalid in the given region", () => {
      expect(() => normalizeCemacWaemuE164("123", "CM")).toThrow(
        /Invalid phone number/,
      );
      expect(() => normalizeCemacWaemuE164("not-a-number", "GH")).toThrow(
        /Invalid phone number/,
      );
      // Valid length for CM but wrong country's dialing code entirely.
      expect(() => normalizeCemacWaemuE164("+14155552671", "CM")).toThrow(
        /Invalid phone number/,
      );
    });

    it("throws for a region outside the supported CEMAC/WAEMU set", () => {
      expect(() =>
        normalizeCemacWaemuE164("+256770000000", "UG" as never),
      ).toThrow(/Unsupported region/);
    });

    it("exports the exact set of six supported regions", () => {
      expect([...CEMAC_WAEMU_REGIONS].sort()).toEqual(
        ["CI", "CM", "GH", "KE", "NG", "SN"].sort(),
      );
    });
  });

  describe("configuration mappings", () => {
    it("exports valid PROVIDER_PREFIXES and PROVIDER_PHONE_FORMATS", () => {
      expect(PROVIDER_PREFIXES.mtn).toBeDefined();
      expect(PROVIDER_PREFIXES.airtel).toBeDefined();
      expect(PROVIDER_PREFIXES.orange).toBeDefined();
      expect(PROVIDER_PREFIXES.vodacom).toBeDefined();
      expect(PROVIDER_PREFIXES.tigo).toBeDefined();

      expect(PROVIDER_PHONE_FORMATS.mtn.output).toBe("e164");
      expect(PROVIDER_PHONE_FORMATS.airtel.output).toBe("national");
    });
  });
});
