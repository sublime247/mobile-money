import { cleanMoMoBackupNumber } from "../../src/utils/phoneUtils";

describe("MoMo Backup Phone Number - cleanMoMoBackupNumber (#2085)", () => {
  it("should normalize and clean valid MTN Cameroon number", () => {
    const result = cleanMoMoBackupNumber("677 12 34 56", undefined, {
      defaultRegion: "CM",
    });

    expect(result.valid).toBe(true);
    expect(result.cleanPhoneNumber).toBe("+237677123456");
    expect(result.provider).toBe("mtn");
    expect(result.country).toBe("CM");
  });

  it("should clean number with international format and spaces", () => {
    const result = cleanMoMoBackupNumber("+237 651 23 45 67");

    expect(result.valid).toBe(true);
    expect(result.cleanPhoneNumber).toBe("+237651234567");
    expect(result.provider).toBe("orange");
    expect(result.country).toBe("CM");
  });

  it("should reject empty or whitespace-only backup number", () => {
    const result1 = cleanMoMoBackupNumber("");
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain("required");

    const result2 = cleanMoMoBackupNumber("   ");
    expect(result2.valid).toBe(false);
    expect(result2.error).toContain("required");
  });

  it("should reject invalid phone number string", () => {
    const result = cleanMoMoBackupNumber("abcdefg1234");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid backup phone number format");
  });

  it("should reject when backup number is identical to primary phone number", () => {
    const result = cleanMoMoBackupNumber("+237677123456", "+237677123456");
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "Backup phone number cannot be the same as primary phone number",
    );
  });

  it("should reject when backup and primary match despite differing formats", () => {
    const result = cleanMoMoBackupNumber("677 12 34 56", "+237677123456", {
      defaultRegion: "CM",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "Backup phone number cannot be the same as primary phone number",
    );
  });

  it("should accept different backup and primary numbers", () => {
    const result = cleanMoMoBackupNumber("+237651234567", "+237677123456");
    expect(result.valid).toBe(true);
    expect(result.cleanPhoneNumber).toBe("+237651234567");
    expect(result.provider).toBe("orange");
  });

  it("should validate and enforce provider match when requested", () => {
    const result = cleanMoMoBackupNumber("+237677123456", undefined, {
      expectedProvider: "orange",
      enforceProviderMatch: true,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not belong to the ORANGE network");
  });

  it("should succeed when provider matches expected provider", () => {
    const result = cleanMoMoBackupNumber("+237677123456", undefined, {
      expectedProvider: "mtn",
      enforceProviderMatch: true,
    });
    expect(result.valid).toBe(true);
    expect(result.provider).toBe("mtn");
  });
});
