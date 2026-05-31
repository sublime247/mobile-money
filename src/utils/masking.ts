/**
 * Utility functions for masking Personally Identifiable Information (PII).
 */

/**
 * Masks a phone number by keeping the first 4 characters and last 2 characters.
 * @example +237677123456 -> +237***56
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone) return "";
  const cleaned = phone.trim();
  if (cleaned.length <= 6) return cleaned;
  return `${cleaned.slice(0, 4)}***${cleaned.slice(-2)}`;
}

/**
 * Masks an email address by keeping the first 2 characters of the local part.
 * @example johndoe@example.com -> jo***@example.com
 */
export function maskEmail(email: string): string {
  if (!email) return "";
  const [localPart, domain] = email.split("@");
  if (!domain) return email;
  const maskedLocal =
    localPart.length <= 2 ? `${localPart}***` : `${localPart.slice(0, 2)}***`;
  return `${maskedLocal}@${domain}`;
}

/**
 * Masks a Stellar address by keeping the first 4 and last 4 characters.
 * @example GBAR...ABCD -> GBAR...ABCD
 */
export function maskStellarAddress(address: string): string {
  if (!address) return "";
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * General purpose masking utility.
 */
export function maskSensitiveData(
  data: string,
  type: "phone" | "email" | "stellar",
): string {
  if (!data) return "";
  switch (type) {
    case "phone":
      return maskPhoneNumber(data);
    case "email":
      return maskEmail(data);
    case "stellar":
      return maskStellarAddress(data);
    default:
      return data;
  }
}
