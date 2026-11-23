// Stub the SDK so this suite stays a pure unit test (no network/native
// surface). Only the two helpers `sep24.ts` uses are needed.
jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromPublicKey: jest.fn((key: string) => {
      if (typeof key !== "string" || !key.startsWith("G") || key.length !== 56) {
        throw new Error("Invalid public key");
      }
      return { publicKey: () => key };
    }),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn(
      (key: string) =>
        typeof key === "string" && key.startsWith("G") && key.length === 56,
    ),
  },
  Transaction: class {},
}));

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => "Testnet"),
  STELLAR_NETWORKS: { TESTNET: "Testnet", PUBLIC: "Public" },
}));

jest.mock("../../middleware/rateLimit", () => ({
  sep24RateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../services/stellar/webhooks", () => ({
  enqueueSepWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../utils/sep24Signature", () => ({
  generateSignedSep24Url: jest.fn(
    (base: string, params: Record<string, string>) =>
      `${base}?${new URLSearchParams(params).toString()}`,
  ),
  verifySep24Signature: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import {
  calculateFee,
  initiateDeposit,
} from "../sep24";
import {
  calculateDepositFee,
  resolveFeeRates,
  validateDepositLimits,
} from "../../services/feeCalculator";

const account =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("SEP-24 deposit fee preview", () => {
  const originalFeeFixed = process.env.SEP24_DEPOSIT_FEE_FIXED;
  const originalFeePercent = process.env.SEP24_DEPOSIT_FEE_PERCENT;
  const originalProviderFees = process.env.SEP24_PROVIDER_FEES_JSON;

  beforeEach(() => {
    process.env.SEP24_DEPOSIT_FEE_FIXED = "5";
    process.env.SEP24_DEPOSIT_FEE_PERCENT = "1.5";
    delete process.env.SEP24_PROVIDER_FEES_JSON;
  });

  afterAll(() => {
    if (originalFeeFixed === undefined)
      delete process.env.SEP24_DEPOSIT_FEE_FIXED;
    else process.env.SEP24_DEPOSIT_FEE_FIXED = originalFeeFixed;
    if (originalFeePercent === undefined)
      delete process.env.SEP24_DEPOSIT_FEE_PERCENT;
    else process.env.SEP24_DEPOSIT_FEE_PERCENT = originalFeePercent;
    if (originalProviderFees === undefined)
      delete process.env.SEP24_PROVIDER_FEES_JSON;
    else process.env.SEP24_PROVIDER_FEES_JSON = originalProviderFees;
  });

  describe("calculateDepositFee", () => {
    it("applies fixed + percentage fees and derives the net amount", () => {
      const result = calculateDepositFee({
        amount: 1000,
        asset: { fee_fixed: 5, fee_percent: 1.5 },
      });

      expect(result.fee_fixed).toBe(5);
      expect(result.fee_percent).toBe(1.5);
      // 5 + 1000 * 0.015 = 20
      expect(result.fee_amount).toBe(20);
      expect(result.net_amount).toBe(980);
      expect(result.within_limits).toBe(true);
      expect(result.limit_error).toBeNull();
    });

    it("rounds fee math to cents without float dust", () => {
      const result = calculateDepositFee({
        amount: 10.1,
        asset: { fee_fixed: 0.1, fee_percent: 0.3 },
      });
      // 0.1 + 10.1 * 0.003 = 0.1303 -> 0.13
      expect(result.fee_amount).toBe(0.13);
      expect(result.net_amount).toBe(9.97);
    });

    it("uses provider overrides case-insensitively", () => {
      const result = calculateDepositFee({
        amount: 100,
        provider: " MTN ",
        asset: {
          fee_fixed: 5,
          fee_percent: 1.5,
          provider_fees: {
            mtn: { fee_fixed: 2, fee_percent: 1 },
          },
        },
      });

      expect(result.provider).toBe("mtn");
      expect(result.fee_fixed).toBe(2);
      expect(result.fee_percent).toBe(1);
      expect(result.fee_amount).toBe(3); // 2 + 100 * 0.01
      expect(result.net_amount).toBe(97);
    });

    it("inherits the other component when a provider overrides only one", () => {
      const rates = resolveFeeRates(
        {
          fee_fixed: 5,
          fee_percent: 1.5,
          provider_fees: { airtel: { fee_percent: 0.5 } },
        },
        "airtel",
      );
      expect(rates).toEqual({ fee_fixed: 5, fee_percent: 0.5 });
    });

    it("falls back to asset defaults for an unknown provider", () => {
      const rates = resolveFeeRates(
        { fee_fixed: 5, fee_percent: 1.5, provider_fees: { mtn: { fee_fixed: 1 } } },
        "orange",
      );
      expect(rates).toEqual({ fee_fixed: 5, fee_percent: 1.5 });
    });

    it("never returns a negative net amount", () => {
      const result = calculateDepositFee({
        amount: 1,
        asset: { fee_fixed: 5, fee_percent: 0 },
      });
      expect(result.fee_amount).toBe(5);
      expect(result.net_amount).toBe(0);
    });
  });

  describe("validateDepositLimits", () => {
    it("accepts a value inside the min/max range", () => {
      expect(validateDepositLimits(100, { min_amount: 10, max_amount: 1000 }))
        .toBeNull();
    });

    it("rejects non-positive, non-finite, below-min and above-max amounts", () => {
      const asset = { min_amount: 10, max_amount: 1000 };
      expect(validateDepositLimits(0, asset)).toBe(
        "Deposit amount must be a positive number",
      );
      expect(validateDepositLimits(NaN, asset)).toBe(
        "Deposit amount must be a positive number",
      );
      expect(validateDepositLimits(9, asset)).toBe(
        "Minimum deposit amount is 10",
      );
      expect(validateDepositLimits(1001, asset)).toBe(
        "Maximum deposit amount is 1000",
      );
    });

    it("still exposes fee math when limits fail", () => {
      const result = calculateDepositFee({
        amount: 5,
        asset: { fee_fixed: 1, fee_percent: 10, min_amount: 10 },
      });
      expect(result.fee_amount).toBe(1.5);
      expect(result.within_limits).toBe(false);
      expect(result.limit_error).toBe("Minimum deposit amount is 10");
    });
  });

  describe("calculateFee (SEP-24 /fee endpoint helper)", () => {
    it("returns accurate fee details and net amount for the configured asset", async () => {
      const result = await calculateFee("XLM", "100", "deposit");
      expect(result.fee).toBe("6.50"); // 5 + 100 * 1.5%
      expect(result.fee_details).toEqual({ fixed: 5, percent: 1.5 });
      expect(result.net_amount).toBe("93.50");
    });

    it("honours a provider override when supplied", async () => {
      process.env.SEP24_PROVIDER_FEES_JSON = JSON.stringify({
        mtn: { fee_fixed: 1, fee_percent: 2 },
      });
      const result = await calculateFee("XLM", "100", "deposit", "mtn");
      expect(result.fee).toBe("3.00"); // 1 + 100 * 2%
      expect(result.fee_details).toEqual({ fixed: 1, percent: 2 });
    });
  });

  describe("initiateDeposit (interactive session payload)", () => {
    it("includes fee_fixed, fee_percent and net_amount in the fee preview", async () => {
      const result = await initiateDeposit({
        asset_code: "XLM",
        amount: "100",
        account,
        provider: "mtn",
      });

      expect(result.fee_preview).toBeDefined();
      expect(result.fee_preview!.fee_fixed).toBe(5);
      expect(result.fee_preview!.fee_percent).toBe(1.5);
      expect(result.fee_preview!.fee_amount).toBe(6.5);
      expect(result.fee_preview!.net_amount).toBe(93.5);
      expect(result.url).toContain("fee_fixed=5");
      expect(result.url).toContain("net_amount=93.5");
    });

    it("rejects deposits outside the configured limits", async () => {
      await expect(
        initiateDeposit({ asset_code: "XLM", amount: "0.5", account }),
      ).rejects.toThrow("Minimum deposit amount is 1");
      await expect(
        initiateDeposit({
          asset_code: "XLM",
          amount: "1000001",
          account,
        }),
      ).rejects.toThrow("Maximum deposit amount is 1000000");
    });
  });
});
