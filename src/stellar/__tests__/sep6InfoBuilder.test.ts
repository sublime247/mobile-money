import { sep6InfoResponseSchema } from "../../schemas/sep6";
import type { Sep6Config } from "../sep6";
import { buildDynamicSep6Info, evaluateRailStatus } from "../sep6InfoBuilder";

const config: Sep6Config = {
  transferServer: "https://transfer.example.test",
  anchorStellarAccount: "GANCHORTESTACCOUNT",
  assets: {
    XLM: {
      asset_code: "XLM",
      provider: "mtn",
      deposits_enabled: true,
      withdrawals_enabled: true,
      min_amount: 1,
      max_amount: 1_000_000,
      fee_fixed: 0.5,
      fee_percent: 1,
    },
    USDC: {
      asset_code: "USDC",
      provider: "orange",
      deposits_enabled: true,
      withdrawals_enabled: false,
      min_amount: 5,
      max_amount: 500,
      fee_fixed: 0,
      fee_percent: 0.5,
    },
  },
};

describe("buildDynamicSep6Info", () => {
  it("produces a payload that adheres to the SEP-6 /info schema", () => {
    const info = buildDynamicSep6Info(config, {
      providerHealth: { mtn: { status: "up" }, orange: { status: "up" } },
    });

    expect(() => sep6InfoResponseSchema.parse(info)).not.toThrow();
    expect(info.deposit).toHaveProperty("XLM");
    expect(info.deposit).toHaveProperty("USDC");
    expect(info.withdraw).toHaveProperty("XLM");
    expect(info.withdraw).not.toHaveProperty("USDC");
    expect(info.fee).toEqual({ enabled: true });
  });

  it("exposes fixed and percentage fees and limits per asset", () => {
    const info = buildDynamicSep6Info(config);

    expect(info.deposit.XLM).toMatchObject({
      enabled: true,
      min_amount: 1,
      max_amount: 1_000_000,
      fee_fixed: 0.5,
      fee_percent: 1,
    });
    expect(info.deposit.USDC).toMatchObject({ fee_fixed: 0, fee_percent: 0.5 });
  });

  it("advertises a rail as disabled when its provider is down", () => {
    const info = buildDynamicSep6Info(config, {
      providerHealth: { mtn: { status: "down" }, orange: { status: "up" } },
    });

    expect(info.deposit.XLM).toMatchObject({ enabled: false, fee_fixed: 0.5 });
    expect(info.withdraw.XLM).toMatchObject({ enabled: false });
    expect(info.deposit.USDC).toMatchObject({ enabled: true });
  });

  it("keeps rails enabled when health is unknown", () => {
    const info = buildDynamicSep6Info(config, undefined);
    expect(info.deposit.XLM).toMatchObject({ enabled: true });
    expect(info.withdraw.XLM).toMatchObject({ enabled: true });
  });

  it("filters by asset_code and returns empty maps for unknown codes", () => {
    const filtered = buildDynamicSep6Info(config, { assetCode: "USDC" });
    expect(Object.keys(filtered.deposit)).toEqual(["USDC"]);
    expect(filtered.withdraw).toEqual({});

    const unknown = buildDynamicSep6Info(config, { assetCode: "BTC" });
    expect(unknown.deposit).toEqual({});
    expect(unknown.withdraw).toEqual({});
  });

  it("rejects a corridor whose fee percentage is out of range", () => {
    const broken: Sep6Config = {
      ...config,
      assets: {
        XLM: { ...config.assets.XLM, fee_percent: 150 },
      },
    };
    expect(() => buildDynamicSep6Info(broken)).toThrow();
  });
});

describe("evaluateRailStatus", () => {
  it("keeps a rail without a bound provider enabled", () => {
    expect(
      evaluateRailStatus({ provider: undefined }, { mtn: { status: "down" } }),
    ).toEqual({ enabled: true });
  });

  it("disables only the rail bound to the failing provider", () => {
    const health = {
      mtn: { status: "down" as const },
      orange: { status: "up" as const },
    };
    expect(evaluateRailStatus({ provider: "mtn" }, health)).toEqual({
      enabled: false,
      reason: "provider_down",
    });
    expect(evaluateRailStatus({ provider: "orange" }, health)).toEqual({
      enabled: true,
    });
  });
});
