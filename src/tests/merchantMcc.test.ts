import { describe, expect, it } from "@jest/globals";
import { isValidMerchantMCC, requireValidMerchantMCC } from "../utils/merchantMcc";

describe("Merchant MCC validation", () => {
  it("should accept valid standard MCC codes", () => {
    expect(isValidMerchantMCC("5411")).toBe(true);
    expect(requireValidMerchantMCC("5411")).toBe("5411");
  });

  it("should reject MCC codes that are not numeric or not 4 digits", () => {
    expect(isValidMerchantMCC("54A1")).toBe(false);
    expect(isValidMerchantMCC("541")).toBe(false);
    expect(() => requireValidMerchantMCC("54A1")).toThrow(/Invalid Merchant MCC code/);
    expect(() => requireValidMerchantMCC("541")).toThrow(/Invalid Merchant MCC code/);
  });

  it("should reject unsupported 4-digit codes even if numeric", () => {
    expect(isValidMerchantMCC("9998")).toBe(false);
    expect(() => requireValidMerchantMCC("9998")).toThrow(/Invalid Merchant MCC code/);
  });
});
