import { isValidGAddress, STELLAR_G_ADDRESS_REGEX } from "../../src/utils/stellarAddressValidator";

describe("STELLAR_G_ADDRESS_REGEX", () => {
  it("matches valid 56-character G-addresses", () => {
    // Real mainnet G-addresses (56 chars)
    expect(STELLAR_G_ADDRESS_REGEX.test("GAZC2ODRSME7QBKX6FYI4JRZG2P5FE2E2MGZV5I355P46I4XQXXI2I2Y")).toBe(true);
    expect(STELLAR_G_ADDRESS_REGEX.test("GAAIZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(true);
    expect(STELLAR_G_ADDRESS_REGEX.test("GCKFBEI2TKW7AMMHV4O3435O7G4ZDV4S5DTD4URC7MMS772BR2W2RHDI")).toBe(true);
  });

  it("rejects M-addresses (muxed accounts)", () => {
    // M-addresses start with "M" and are longer (64 chars)
    expect(STELLAR_G_ADDRESS_REGEX.test("MA7QYHYXGM6GSCJ24Y73FZ2FAYBGQ4MWU7MF2J55W2E2ZC32G33QZ2K")).toBe(false);
    expect(STELLAR_G_ADDRESS_REGEX.test("MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });

  it("rejects addresses that are too short", () => {
    expect(STELLAR_G_ADDRESS_REGEX.test("G")).toBe(false);
    expect(STELLAR_G_ADDRESS_REGEX.test("GAA")).toBe(false);
    expect(STELLAR_G_ADDRESS_REGEX.test("GAAIZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6C")).toBe(false); // 55 chars
  });

  it("rejects addresses that are too long", () => {
    expect(STELLAR_G_ADDRESS_REGEX.test("GAAIZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CAAA")).toBe(false); // 59 chars
  });

  it("rejects addresses with invalid base32 characters", () => {
    // Base32 uses A-Z and 2-7 (no 0, 1, 8, 9)
    expect(STELLAR_G_ADDRESS_REGEX.test("GAA0ZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(false); // contains 0
    expect(STELLAR_G_ADDRESS_REGEX.test("GAA1ZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(false); // contains 1
    expect(STELLAR_G_ADDRESS_REGEX.test("GAA8ZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(false); // contains 8
    expect(STELLAR_G_ADDRESS_REGEX.test("GAA9ZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(false); // contains 9
    expect(STELLAR_G_ADDRESS_REGEX.test("GAAIZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6C!")).toBe(false); // special char
  });

  it("rejects lowercase addresses", () => {
    expect(STELLAR_G_ADDRESS_REGEX.test("gaaizr7hskr6o64mhgga6nf7y6bzb d7kb4gcmf7p4p2p7x3qzjxvq6ca")).toBe(false);
    expect(STELLAR_G_ADDRESS_REGEX.test("gazc2odrsme7qbkx6fyi4jrzg2p5fe2e2mgzv5i355p46i4xqxi2i2y")).toBe(false);
  });

  it("rejects empty and null-like inputs", () => {
    expect(STELLAR_G_ADDRESS_REGEX.test("")).toBe(false);
    expect(STELLAR_G_ADDRESS_REGEX.test("   ")).toBe(false);
  });
});

describe("isValidGAddress", () => {
  it("returns true for valid G-addresses", () => {
    expect(isValidGAddress("GAZC2ODRSME7QBKX6FYI4JRZG2P5FE2E2MGZV5I355P46I4XQXXI2I2Y")).toBe(true);
    expect(isValidGAddress("GAAIZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(true);
  });

  it("returns false for non-string inputs", () => {
    expect(isValidGAddress(null as any)).toBe(false);
    expect(isValidGAddress(undefined as any)).toBe(false);
    expect(isValidGAddress(123 as any)).toBe(false);
    expect(isValidGAddress({} as any)).toBe(false);
  });

  it("returns false for invalid formats", () => {
    expect(isValidGAddress("")).toBe(false);
    expect(isValidGAddress("invalid")).toBe(false);
    expect(isValidGAddress("M7QYHYXGM6GSCJ24Y73FZ2FAYBGQ4MWU7MF2J55W2E2ZC32G33QZ2K")).toBe(false);
    expect(isValidGAddress("GAAZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(false); // too short
    expect(isValidGAddress("GAAIZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CAAA")).toBe(false); // too long
    expect(isValidGAddress("GAA0ZR7HSKR6O64MHGGA6NF7Y6BZBD7KB4GCMF7P4P2P7X3QZJXVQ6CA")).toBe(false); // invalid char 0
  });
});
