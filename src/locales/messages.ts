import { SupportedLocale, translate } from "../utils/i18n";

export type Locale = SupportedLocale;

export const getLocalizedMessage = (
  code: string,
  locale: Locale | string = "en",
): string => {
  const englishFallback = translate("errors.DEFAULT", "en");

  return translate(`errors.${code}`, locale, {
    defaultValue: englishFallback,
  });
};