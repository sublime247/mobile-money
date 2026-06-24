import { Request, Response, NextFunction } from "express";
import { resolveLocale, resolveLocaleFromRequest, i18nMiddleware, SUPPORTED_LOCALES, translate } from "../../src/utils/i18n";
import i18next from "i18next";

describe("i18n utils", () => {
  describe("resolveLocale", () => {
    it("should return the exact matched locale", () => {
      expect(resolveLocale("fr")).toBe("fr");
      expect(resolveLocale("en")).toBe("en");
    });

    it("should match language when region is provided", () => {
      expect(resolveLocale("fr-CA")).toBe("fr");
      expect(resolveLocale("en-US")).toBe("en");
      expect(resolveLocale("en_US")).toBe("en"); // Handles underscore
    });

    it("should fallback to en when locale is not supported", () => {
      expect(resolveLocale("de")).toBe("en");
      expect(resolveLocale("zh")).toBe("en");
      expect(resolveLocale("")).toBe("en");
      expect(resolveLocale(undefined)).toBe("en");
    });
  });

  describe("resolveLocaleFromRequest", () => {
    it("should use req.locale if already set", () => {
      const req = { locale: "fr", headers: {} } as Request;
      expect(resolveLocaleFromRequest(req)).toBe("fr");
    });

    it("should parse accept-language header", () => {
      const req = { headers: { "accept-language": "fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5" } } as Request;
      expect(resolveLocaleFromRequest(req)).toBe("fr");
    });

    it("should prioritize correctly from accept-language header", () => {
      const req = { headers: { "accept-language": "de;q=0.9, es;q=0.8" } } as Request;
      expect(resolveLocaleFromRequest(req)).toBe("es");
    });

    it("should fallback to en if no accept-language header", () => {
      const req = { headers: {} } as Request;
      expect(resolveLocaleFromRequest(req)).toBe("en");
    });

    it("should fallback to en if header values are unsupported", () => {
      const req = { headers: { "accept-language": "zh, de" } } as Request;
      expect(resolveLocaleFromRequest(req)).toBe("en");
    });
    
    it("should handle accept-language header as array", () => {
      const req = { headers: { "accept-language": ["fr", "en;q=0.8"] } } as unknown as Request;
      expect(resolveLocaleFromRequest(req)).toBe("fr");
    });
  });

  describe("i18nMiddleware", () => {
    it("should set locale on req and res.locals", () => {
      const req = { headers: { "accept-language": "sw" } } as Request;
      const res = { locals: {} } as Response;
      const next: NextFunction = jest.fn();

      i18nMiddleware(req, res, next);

      expect(req.locale).toBe("sw");
      expect(res.locals.locale).toBe("sw");
      expect(next).toHaveBeenCalled();
    });
  });

  describe("translate", () => {
    beforeAll(() => {
      // Just ensure i18next is mockable or returns keys
      jest.spyOn(i18next, "t").mockImplementation((key: string | string[]) => String(key));
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    it("should call i18next.t with resolved locale", () => {
      translate("some.key", "fr-FR", { count: 1 });
      expect(i18next.t).toHaveBeenCalledWith("some.key", expect.objectContaining({ lng: "fr", count: 1 }));
    });
    
    it("should use fallback locale when none provided", () => {
      translate("some.key");
      expect(i18next.t).toHaveBeenCalledWith("some.key", expect.objectContaining({ lng: "en" }));
    });
  });
});
