import i18next from "i18next";
import { NextFunction, Request, Response } from "express";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import sw from "../locales/sw.json";
import es from "../locales/es.json";
import pt from "../locales/pt.json";

export const SUPPORTED_LOCALES = ["en", "fr", "sw", "es", "pt"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const FALLBACK_LOCALE: SupportedLocale = "en";
const ACCEPT_LANGUAGE_CACHE_LIMIT = 250;
const acceptLanguageCache = new Map<string, SupportedLocale>();

const resources = {
  en: { translation: en },
  fr: { translation: fr },
  sw: { translation: sw },
  es: { translation: es },
  pt: { translation: pt },
} as const;

if (!i18next.isInitialized) {
  i18next.init({
    resources,
    lng: FALLBACK_LOCALE,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    load: "languageOnly",
    cleanCode: true,
    interpolation: {
      escapeValue: false,
    },
    initImmediate: false,
    returnNull: false,
  });
}

function toSupportedLocale(value?: string): SupportedLocale | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return null;
  }

  const exactMatch = SUPPORTED_LOCALES.find((locale) => locale === normalized);
  if (exactMatch) {
    return exactMatch;
  }

  const baseLanguage = normalized.split("-")[0];
  const baseMatch = SUPPORTED_LOCALES.find((locale) => locale === baseLanguage);
  return baseMatch ?? null;
}

function parseAcceptLanguage(header: string): SupportedLocale {
  const candidates = header
    .split(",")
    .map((rawEntry) => {
      const [language, ...params] = rawEntry.trim().split(";");
      let quality = 1;

      for (const param of params) {
        const trimmedParam = param.trim();
        if (!trimmedParam.startsWith("q=")) {
          continue;
        }

        const parsedQuality = Number(trimmedParam.slice(2));
        if (!Number.isNaN(parsedQuality)) {
          quality = parsedQuality;
        }
      }

      return { language, quality };
    })
    .filter((entry) => Boolean(entry.language))
    .sort((a, b) => b.quality - a.quality);

  for (const entry of candidates) {
    const supported = toSupportedLocale(entry.language);
    if (supported) {
      return supported;
    }
  }

  return FALLBACK_LOCALE;
}

function setAcceptLanguageCache(header: string, locale: SupportedLocale): void {
  if (acceptLanguageCache.size >= ACCEPT_LANGUAGE_CACHE_LIMIT) {
    const firstKey = acceptLanguageCache.keys().next().value;
    if (firstKey) {
      acceptLanguageCache.delete(firstKey);
    }
  }

  acceptLanguageCache.set(header, locale);
}

export function resolveLocale(value?: string): SupportedLocale {
  return toSupportedLocale(value) ?? FALLBACK_LOCALE;
}

export function resolveLocaleFromRequest(req: Request): SupportedLocale {
  if (req.locale) {
    return resolveLocale(req.locale);
  }

  const header = req.headers["accept-language"];
  const headerValue = Array.isArray(header) ? header.join(",") : header;

  if (!headerValue) {
    return FALLBACK_LOCALE;
  }

  const cached = acceptLanguageCache.get(headerValue);
  if (cached) {
    return cached;
  }

  const locale = parseAcceptLanguage(headerValue);
  setAcceptLanguageCache(headerValue, locale);
  return locale;
}

export function translate(
  key: string,
  locale?: string,
  options: Record<string, unknown> = {},
): string {
  const resolvedLocale = resolveLocale(locale);
  return i18next.t(key, {
    lng: resolvedLocale,
    ...options,
  });
}

export function i18nMiddleware(req: Request, res: Response, next: NextFunction): void {
  const locale = resolveLocaleFromRequest(req);
  req.locale = locale;
  (res.locals as Record<string, unknown>).locale = locale;
  next();
}

declare module "express-serve-static-core" {
  interface Request {
    locale?: SupportedLocale;
  }
}
