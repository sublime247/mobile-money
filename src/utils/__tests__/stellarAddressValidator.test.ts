import {
  STELLAR_G_ADDRESS_REGEX,
  assertStrictStellarGAddress,
  isStrictStellarGAddress,
} from "../stellarAddressValidator";

describe("stellarAddressValidator", () => {
  const validAddress =
    "GBYSA76FFFKKFM5SRZP7QZNSDJMZZJ6KC6U3GJWZ6MHQJTQKJ5XHFV3A";

  it("accepts a valid Stellar G-address", () => {
    expect(STELLAR_G_ADDRESS_REGEX.test(validAddress)).toBe(true);
    expect(isStrictStellarGAddress(validAddress)).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isStrictStellarGAddress("INVALID_ADDRESS")).toBe(false);
    expect(isStrictStellarGAddress("G123")).toBe(false);
    expect(isStrictStellarGAddress("M" + "A".repeat(55))).toBe(false);
  });

  it("throws for invalid values", () => {
    expect(() => assertStrictStellarGAddress("INVALID_ADDRESS")).toThrow(
      "Invalid Stellar G-address in address",
    );
  });
});
