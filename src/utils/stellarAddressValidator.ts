/**
 * Strict regex validator for Stellar G-addresses (Ed25519 public keys).
 *
 * Stellar G-addresses are base32-encoded Ed25519 public keys with a 4-byte
 * network identifier prefix (0x30 for mainnet) and a 2-byte SHA-256 checksum.
 *
 * Format: 1 byte network ID + 32 bytes public key + 2 bytes checksum,
 * all encoded in base32 (A-Z, 2-7) and prefixed with "G".
 *
 * Total length: 56 characters, always starting with "G".
 *
 * This regex provides a fast pre-flight check. For full validation, use
 * `StellarSdk.StrKey.isValidEd25519PublicKey()` which also verifies the
 * base32 decoding and checksum.
 *
 * @see https://stellar.github.io/stellar-sdk/StrKey.html
 */

// Base32-encoded Ed25519 public key with network ID prefix and checksum.
// G (1 char) + base32(1 + 32 + 2) = 1 + 55 = 56 chars total.
// Base32 alphabet: A-Z (26 chars) + 2-7 (6 chars) = 32 chars.
export const STELLAR_G_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Validate a Stellar G-address using strict regex matching.
 *
 * Returns false for any string that does not match the expected format:
 * - Must start with "G"
 * - Must be exactly 56 characters
 * - Must contain only base32 characters (A-Z, 2-7)
 *
 * This is a fast pre-flight check. For cryptographic validation, use
 * `StellarSdk.StrKey.isValidEd25519PublicKey()` instead.
 *
 * @param address - The address string to validate
 * @returns true if the address matches the G-address format
 *
 * @example
 * isValidGAddress("GAZC2ODRSME7QBKX6FYI4JRZG2P5FE2E2MGZV5I355P46I4XQXXI2I2Y") // true
 * isValidGAddress("invalid") // false
 * isValidGAddress("M...") // false (M-address, not G-address)
 */
export function isValidGAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  return STELLAR_G_ADDRESS_REGEX.test(address);
}
