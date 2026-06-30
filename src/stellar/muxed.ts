import * as StellarSdk from "stellar-sdk";

export interface MuxedAccountInfo {
  mAddress: string;
  baseAddress: string;
  id: string;
}

/**
 * Check if an address is a muxed account (M-address).
 */
export function isMuxedAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  return address.startsWith("M");
}

/**
 * Parse a muxed account address and extract its components.
 * @throws Error if the address is invalid or not a muxed account
 */
export function parseMuxedAccount(mAddress: string): MuxedAccountInfo {
  if (!isMuxedAddress(mAddress)) {
    throw new Error("Address is not a muxed account (must start with M)");
  }

  try {
    const muxed = StellarSdk.MuxedAccount.fromAddress(mAddress, "0");
    const baseAddress = muxed.baseAccount().accountId();
    const id = muxed.id();

    return {
      mAddress,
      baseAddress,
      id,
    };
  } catch (error) {
    throw new Error(
      `Failed to parse muxed account: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * Extract the base G-address from a muxed account.
 * @throws Error if the address is invalid
 */
export function getBaseAddress(mAddress: string): string {
  if (!isMuxedAddress(mAddress)) {
    throw new Error("Address is not a muxed account");
  }

  try {
    const muxed = StellarSdk.MuxedAccount.fromAddress(mAddress, "0");
    return muxed.baseAccount().accountId();
  } catch (error) {
    throw new Error(
      `Failed to extract base address: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * Extract the memo ID from a muxed account.
 * @throws Error if the address is invalid
 */
export function getMuxedAccountId(mAddress: string): string {
  const info = parseMuxedAccount(mAddress);
  return info.id;
}

export interface ParsedAddress {
  /** 'G' for a standard Ed25519 account, 'M' for a muxed account */
  type: "G" | "M";
  /** The original address as supplied */
  address: string;
  /** Underlying G-address (same as address for type 'G') */
  baseAddress: string;
  /** 64-bit muxed ID, null for type 'G' */
  memoId: string | null;
}

/**
 * Parse any Stellar address (G- or M-) into a normalised structure.
 *
 * - Uses StrKey.isValidEd25519PublicKey  to validate G-addresses.
 * - Uses StrKey.isValidMed25519PublicKey to validate M-addresses.
 * - Throws an Error for anything that is neither.
 */
export function parseAddress(address: string): ParsedAddress {
  if (!address || typeof address !== "string") {
    throw new Error("Invalid address: must be a non-empty string");
  }

  if (StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    return {
      type: "G",
      address,
      baseAddress: address,
      memoId: null,
    };
  }

  if (StellarSdk.StrKey.isValidMed25519PublicKey(address)) {
    try {
      const muxed = StellarSdk.MuxedAccount.fromAddress(address, "0");
      return {
        type: "M",
        address,
        baseAddress: muxed.baseAccount().accountId(),
        memoId: muxed.id(),
      };
    } catch (error) {
      throw new Error(
        `Failed to decode muxed address: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  throw new Error(`Invalid Stellar address: "${address}"`);
}

/**
 * Route an incoming payment by extracting user routing information from muxed account.
 * Returns the memo ID that can be used to identify the specific user.
 */
export function routePayment(destinationAddress: string): {
  baseAddress: string;
  userId: string | null;
} {
  if (!isMuxedAddress(destinationAddress)) {
    return {
      baseAddress: destinationAddress,
      userId: null,
    };
  }

  const info = parseMuxedAccount(destinationAddress);
  return {
    baseAddress: info.baseAddress,
    userId: info.id,
  };
}

/**
 * Resolve any Stellar address (G- or M-) to its base G-address.
 *
 * - For G-addresses, returns the address unchanged.
 * - For M-addresses, extracts and returns the underlying G-address.
 * - Throws an Error if the address is invalid.
 */
export function resolveToBaseAddress(address: string): string {
  if (!address || typeof address !== "string") {
    throw new Error("Invalid address: must be a non-empty string");
  }

  // If it's a muxed address, extract the base address
  if (isMuxedAddress(address)) {
    try {
      const muxed = StellarSdk.MuxedAccount.fromAddress(address, "0");
      return muxed.baseAccount().accountId();
    } catch (error) {
      throw new Error(
        `Failed to resolve muxed address: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  // Validate that it's a valid G-address
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(`Invalid Stellar address: "${address}"`);
  }

  return address;
}
