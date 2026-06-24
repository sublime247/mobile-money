import * as StellarSdk from "stellar-sdk";

export const STELLAR_G_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function isStrictStellarGAddress(address: unknown): address is string {
  if (typeof address !== "string") {
    return false;
  }

  return (
    STELLAR_G_ADDRESS_REGEX.test(address) &&
    StellarSdk.StrKey.isValidEd25519PublicKey(address)
  );
}

export function assertStrictStellarGAddress(
  address: unknown,
  fieldName = "address",
): string {
  if (!isStrictStellarGAddress(address)) {
    throw new Error(`Invalid Stellar G-address in ${fieldName}`);
  }

  return address;
}
