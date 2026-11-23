import { getTelecomProviderLimits, telecomProviderLimits } from "../config";

describe("getTelecomProviderLimits (#2277 env var overrides)", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("returns the static default limiter for MTN when no env override is set", () => {
    delete process.env.MTN_RATE_LIMIT_MAX_PER_SEC;
    const limits = getTelecomProviderLimits("mtn");
    expect(limits.limiter).toEqual({ max: 10, duration: 1000 });
  });

  it("returns the static default limiter for Orange when no env override is set", () => {
    delete process.env.ORANGE_RATE_LIMIT_MAX_PER_SEC;
    const limits = getTelecomProviderLimits("orange");
    expect(limits.limiter).toEqual({ max: 5, duration: 1000 });
  });

  it("MTN_RATE_LIMIT_MAX_PER_SEC overrides limiter.max for MTN only", () => {
    process.env.MTN_RATE_LIMIT_MAX_PER_SEC = "25";
    const mtn = getTelecomProviderLimits("mtn");
    expect(mtn.limiter).toEqual({ max: 25, duration: 1000 });

    // Orange must be unaffected by MTN's override.
    const orange = getTelecomProviderLimits("orange");
    expect(orange.limiter).toEqual({ max: 5, duration: 1000 });
  });

  it("ORANGE_RATE_LIMIT_MAX_PER_SEC overrides limiter.max for Orange only", () => {
    process.env.ORANGE_RATE_LIMIT_MAX_PER_SEC = "7";
    const orange = getTelecomProviderLimits("orange");
    expect(orange.limiter).toEqual({ max: 7, duration: 1000 });
  });

  it("ignores a non-numeric or zero env override and falls back to the static default", () => {
    process.env.MTN_RATE_LIMIT_MAX_PER_SEC = "not-a-number";
    expect(getTelecomProviderLimits("mtn").limiter).toEqual(
      telecomProviderLimits.MTN.limiter,
    );

    process.env.MTN_RATE_LIMIT_MAX_PER_SEC = "0";
    expect(getTelecomProviderLimits("mtn").limiter).toEqual(
      telecomProviderLimits.MTN.limiter,
    );

    process.env.MTN_RATE_LIMIT_MAX_PER_SEC = "-5";
    expect(getTelecomProviderLimits("mtn").limiter).toEqual(
      telecomProviderLimits.MTN.limiter,
    );
  });

  it("falls back to DEFAULT for an unrecognized provider", () => {
    const limits = getTelecomProviderLimits("some-unknown-provider");
    expect(limits).toEqual(telecomProviderLimits.DEFAULT);
  });

  it("is case-insensitive for the provider name", () => {
    process.env.MTN_RATE_LIMIT_MAX_PER_SEC = "12";
    expect(getTelecomProviderLimits("MtN").limiter.max).toBe(12);
    expect(getTelecomProviderLimits("mtn").limiter.max).toBe(12);
  });
});
