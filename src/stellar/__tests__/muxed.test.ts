import * as StellarSdk from "stellar-sdk";
import {
  isMuxedAddress,
  parseMuxedAccount,
  getBaseAddress,
  getMuxedAccountId,
  routePayment,
} from "../muxed";

describe("Muxed Account Support (SEP-23)", () => {
  const TEST_BASE_ADDRESS =
    "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const TEST_MUXED_ID = "1234567890";

  let testMuxedAddress: string;

  beforeAll(() => {
    const account = new StellarSdk.Account(TEST_BASE_ADDRESS, "0");
    const muxed = new StellarSdk.MuxedAccount(account, "0");
    muxed.setId(TEST_MUXED_ID);
    testMuxedAddress = muxed.accountId();
  });

  describe("isMuxedAddress", () => {
    it("should return true for M-addresses", () => {
      expect(isMuxedAddress(testMuxedAddress)).toBe(true);
    });

    it("should return false for G-addresses", () => {
      expect(isMuxedAddress(TEST_BASE_ADDRESS)).toBe(false);
    });

    it("should return false for invalid input", () => {
      expect(isMuxedAddress("")).toBe(false);
      expect(isMuxedAddress("invalid")).toBe(false);
    });

    it("should return false for null/undefined", () => {
      expect(isMuxedAddress(null as any)).toBe(false);
      expect(isMuxedAddress(undefined as any)).toBe(false);
    });
  });

  describe("parseMuxedAccount", () => {
    it("should parse valid muxed account and extract components", () => {
      const result = parseMuxedAccount(testMuxedAddress);

      expect(result).toHaveProperty("mAddress");
      expect(result).toHaveProperty("baseAddress");
      expect(result).toHaveProperty("id");

      expect(result.mAddress).toBe(testMuxedAddress);
      expect(result.baseAddress).toBe(TEST_BASE_ADDRESS);
      expect(result.id).toBe(TEST_MUXED_ID);
    });

    it("should throw error for non-muxed address", () => {
      expect(() => parseMuxedAccount(TEST_BASE_ADDRESS)).toThrow(
        "Address is not a muxed account",
      );
    });

    it("should throw error for invalid address format", () => {
      expect(() => parseMuxedAccount("MINVALID123")).toThrow(
        "Failed to parse muxed account",
      );
    });
  });

  describe("getBaseAddress", () => {
    it("should extract base G-address from muxed account", () => {
      const baseAddress = getBaseAddress(testMuxedAddress);
      expect(baseAddress).toBe(TEST_BASE_ADDRESS);
    });

    it("should throw error for non-muxed address", () => {
      expect(() => getBaseAddress(TEST_BASE_ADDRESS)).toThrow(
        "Address is not a muxed account",
      );
    });

    it("should throw error for invalid muxed address", () => {
      expect(() => getBaseAddress("MINVALID")).toThrow(
        "Failed to extract base address",
      );
    });
  });

  describe("getMuxedAccountId", () => {
    it("should extract memo ID from muxed account", () => {
      const id = getMuxedAccountId(testMuxedAddress);
      expect(id).toBe(TEST_MUXED_ID);
    });

    it("should throw error for non-muxed address", () => {
      expect(() => getMuxedAccountId(TEST_BASE_ADDRESS)).toThrow(
        "Address is not a muxed account",
      );
    });
  });

  describe("routePayment", () => {
    it("should route payment to specific user via muxed ID", () => {
      const result = routePayment(testMuxedAddress);

      expect(result.baseAddress).toBe(TEST_BASE_ADDRESS);
      expect(result.userId).toBe(TEST_MUXED_ID);
    });

    it("should handle regular G-address without user routing", () => {
      const result = routePayment(TEST_BASE_ADDRESS);

      expect(result.baseAddress).toBe(TEST_BASE_ADDRESS);
      expect(result.userId).toBeNull();
    });

    it("should correctly route multiple different muxed accounts", () => {
      const account1 = new StellarSdk.Account(TEST_BASE_ADDRESS, "0");
      const muxed1 = new StellarSdk.MuxedAccount(account1, "0");
      muxed1.setId("100");
      const mAddress1 = muxed1.accountId();

      const account2 = new StellarSdk.Account(TEST_BASE_ADDRESS, "0");
      const muxed2 = new StellarSdk.MuxedAccount(account2, "0");
      muxed2.setId("200");
      const mAddress2 = muxed2.accountId();

      const result1 = routePayment(mAddress1);
      const result2 = routePayment(mAddress2);

      expect(result1.userId).toBe("100");
      expect(result2.userId).toBe("200");
      expect(result1.baseAddress).toBe(TEST_BASE_ADDRESS);
      expect(result2.baseAddress).toBe(TEST_BASE_ADDRESS);
    });
  });

  describe("SEP-23 Compliance", () => {
    it("should handle zero memo ID", () => {
      const account = new StellarSdk.Account(TEST_BASE_ADDRESS, "0");
      const muxed = new StellarSdk.MuxedAccount(account, "0");
      muxed.setId("0");
      const mAddress = muxed.accountId();

      const result = parseMuxedAccount(mAddress);
      expect(result.id).toBe("0");
      expect(result.baseAddress).toBe(TEST_BASE_ADDRESS);
    });

    it("should handle large memo IDs (uint64 max)", () => {
      const account = new StellarSdk.Account(TEST_BASE_ADDRESS, "0");
      const muxed = new StellarSdk.MuxedAccount(account, "0");
      const largeId = "18446744073709551615";
      muxed.setId(largeId);
      const mAddress = muxed.accountId();

      const result = parseMuxedAccount(mAddress);
      expect(result.id).toBe(largeId);
    });

    it("should maintain base address integrity across different IDs", () => {
      const ids = ["1", "999", "1000000", "9999999999"];

      ids.forEach((id) => {
        const account = new StellarSdk.Account(TEST_BASE_ADDRESS, "0");
        const muxed = new StellarSdk.MuxedAccount(account, "0");
        muxed.setId(id);
        const mAddress = muxed.accountId();

        const parsed = parseMuxedAccount(mAddress);
        expect(parsed.baseAddress).toBe(TEST_BASE_ADDRESS);
        expect(parsed.id).toBe(id);
      });
    });
  });
});
