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
