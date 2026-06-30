describe("Limits Configuration Validation", () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to allow re-importing with new env vars
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    // Restore original env
    process.env = originalEnv;
  });

  it("should accept valid environment variable overrides", () => {
    process.env.LIMIT_UNVERIFIED = "5000";
    process.env.LIMIT_BASIC = "50000";
    process.env.LIMIT_FULL = "500000";

    const { TRANSACTION_LIMITS, KYCLevel } = require("../../src/config/limits");

    expect(TRANSACTION_LIMITS[KYCLevel.Unverified]).toBe(5000);
    expect(TRANSACTION_LIMITS[KYCLevel.Basic]).toBe(50000);
    expect(TRANSACTION_LIMITS[KYCLevel.Full]).toBe(500000);
  });

  it("should throw error for negative limit values", () => {
    process.env.LIMIT_UNVERIFIED = "-1000";

    expect(() => {
      require("../../src/config/limits");
    }).toThrow("All transaction limits must be positive finite numbers");
  });

  it("should throw error for zero limit values", () => {
    process.env.LIMIT_BASIC = "0";

    expect(() => {
      require("../../src/config/limits");
    }).toThrow("All transaction limits must be positive finite numbers");
  });

  it("should throw error when Basic limit is less than Unverified limit", () => {
    process.env.LIMIT_UNVERIFIED = "100000";
    process.env.LIMIT_BASIC = "10000";

    expect(() => {
      require("../../src/config/limits");
    }).toThrow("Basic KYC limit must be >= Unverified limit");
  });

  it("should throw error when Full limit is less than Basic limit", () => {
    process.env.LIMIT_BASIC = "1000000";
    process.env.LIMIT_FULL = "100000";

    expect(() => {
      require("../../src/config/limits");
    }).toThrow("Full KYC limit must be >= Basic limit");
  });

  it("should throw error for non-finite values (Infinity)", () => {
    process.env.LIMIT_FULL = "Infinity";

    expect(() => {
      require("../../src/config/limits");
    }).toThrow("All transaction limits must be positive finite numbers");
  });

  it("should throw error for NaN values", () => {
    process.env.LIMIT_UNVERIFIED = "not-a-number";

    expect(() => {
      require("../../src/config/limits");
    }).toThrow("All transaction limits must be positive finite numbers");
  });

  it("should accept equal values for adjacent tiers", () => {
    process.env.LIMIT_UNVERIFIED = "10000";
    process.env.LIMIT_BASIC = "10000";
    process.env.LIMIT_FULL = "10000";

    expect(() => {
      const { TRANSACTION_LIMITS } = require("../../src/config/limits");
      expect(TRANSACTION_LIMITS).toBeDefined();
    }).not.toThrow();
  });
});
