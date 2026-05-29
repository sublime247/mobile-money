import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type MobileProvider = "mtn" | "airtel" | "orange";
type PhoneOutputFormat = "e164" | "national";

interface ProviderPhoneFormatConfig {
  defaultRegion: CountryCode;
  output: PhoneOutputFormat;
}

/**
 * Standard mapping of prefixes to Mobile Network Operators.
 * These are common prefixes for regions like Uganda/Rwanda/Cameroon/Ghana.
 */
const PROVIDER_PREFIXES: Record<MobileProvider, string[]> = {
  mtn: ["23767", "23768", "25677", "25678", "23324", "23354", "23355", "23359"],
  airtel: ["23766", "25670", "25675", "23326", "23356", "23357"],
  orange: ["23765", "23769", "22507", "22177"],
};

const PROVIDER_PHONE_FORMATS: Record<MobileProvider, ProviderPhoneFormatConfig> = {
  mtn: {
    defaultRegion: "CM",
    output: "e164",
  },
  airtel: {
    defaultRegion: (process.env.AIRTEL_PHONE_REGION as CountryCode) || "CM",
    output: "national",
  },
  orange: {
    defaultRegion: "CM",
    output: "e164",
  },
};

function parseFlexiblePhoneNumber(
  phoneNumber: string,
  defaultRegion: CountryCode,
) {
  const trimmed = phoneNumber.trim();
  const digitsOnly = trimmed.replace(/\D/g, "");
  const candidates = [trimmed];

  if (digitsOnly && !trimmed.startsWith("+")) {
    candidates.push(`+${digitsOnly}`);
  }

  if (digitsOnly.startsWith("00")) {
    candidates.push(`+${digitsOnly.slice(2)}`);
  }

  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate, defaultRegion);
    if (parsed?.isValid()) {
      return parsed;
    }
  }

  return null;
}

/**
 * Validates if a phone number belongs to the specified provider.
 * @param phoneNumber E.164 formatted number (e.g., +25677...)
 * @param provider The provider selected in the request
 */
export function validatePhoneProviderMatch(
  phoneNumber: string,
  provider: string,
): { valid: boolean; error?: string } {
  const sanitized = phoneNumber.replace(/^\+/, "");
  const targetProvider = provider.toLowerCase() as MobileProvider;

  const prefixes = PROVIDER_PREFIXES[targetProvider];
  if (!prefixes) {
    return { valid: false, error: `Unsupported provider: ${provider}` };
  }

  const isMatch = prefixes.some((prefix) => sanitized.startsWith(prefix));

  if (!isMatch) {
    return {
      valid: false,
      error: `Phone number ${phoneNumber} does not belong to the ${provider.toUpperCase()} network.`,
    };
  }

  return { valid: true };
}

/**
 * Format a phone number according to provider-specific payload requirements.
 * Airtel payouts in particular may require a national-format MSISDN in some
 * regions, so we normalize user input before building the request payload.
 */
export function formatPhoneForProvider(
  phoneNumber: string,
  provider: string,
): string {
  const targetProvider = provider.toLowerCase() as MobileProvider;
  const config = PROVIDER_PHONE_FORMATS[targetProvider];

  if (!config) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const parsed = parseFlexiblePhoneNumber(phoneNumber, config.defaultRegion);
  if (!parsed) {
    throw new Error(`Invalid phone number for ${provider}: ${phoneNumber}`);
  }

  return config.output === "national" ? parsed.nationalNumber : parsed.number;
}
