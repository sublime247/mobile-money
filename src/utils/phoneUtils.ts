export type MobileProvider = "mtn" | "airtel" | "orange";

/**
 * Standard mapping of prefixes to Mobile Network Operators.
 * These are common prefixes for regions like Uganda/Rwanda/Cameroon/Ghana.
 */
const PROVIDER_PREFIXES: Record<MobileProvider, string[]> = {
  mtn: ["23767", "23768", "25677", "25678", "23324", "23354", "23355", "23359"],
  airtel: ["23766", "25670", "25675", "23326", "23356", "23357"],
  orange: ["23765", "23769", "22507", "22177"],
};

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
