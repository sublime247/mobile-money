import { Keypair } from "@stellar/stellar-sdk";
import {
  getSep24Config,
  getSep24Info,
  initiateDeposit,
  initiateWithdrawal,
  DepositRequest,
  WithdrawRequest,
} from "../sep24";

// A fresh valid Stellar ed25519 public key per call, so tests never share
// the module-level active-transaction-count state keyed by account.
function freshAccount(): string {
  return Keypair.random().publicKey();
}

function depositRequest(overrides: Partial<DepositRequest> = {}): DepositRequest {
  return {
    asset_code: "XLM",
    amount: "10",
    account: freshAccount(),
    ...overrides,
  };
}

function withdrawRequest(overrides: Partial<WithdrawRequest> = {}): WithdrawRequest {
  return {
    asset_code: "XLM",
    amount: "10",
    account: freshAccount(),
    ...overrides,
  };
}

describe("SEP-24 multi-currency asset registry", () => {
  describe("getSep24Config", () => {
    it("registers XLM, USDC, and EURC as deposit/withdraw-enabled assets", () => {
      const config = getSep24Config();

      expect(Object.keys(config.assets).sort()).toEqual(["EURC", "USDC", "XLM"]);

      for (const code of ["XLM", "USDC", "EURC"]) {
        const asset = config.assets[code];
        expect(asset.deposits_enabled).toBe(true);
        expect(asset.withdrawals_enabled).toBe(true);
      }
    });

    it("does not set an issuer for the native XLM asset", () => {
      const config = getSep24Config();
      expect(config.assets.XLM.asset_issuer).toBeUndefined();
    });

    it("sets a non-empty issuer for USDC and EURC", () => {
      const config = getSep24Config();
      expect(config.assets.USDC.asset_issuer).toBeTruthy();
      expect(config.assets.EURC.asset_issuer).toBeTruthy();
      expect(config.assets.USDC.asset_issuer).not.toBe(
        config.assets.EURC.asset_issuer,
      );
    });

    it("respects SEP38_USDC_ISSUER and SEP38_EURC_ISSUER env overrides", () => {
      const prevUsdc = process.env.SEP38_USDC_ISSUER;
      const prevEurc = process.env.SEP38_EURC_ISSUER;
      process.env.SEP38_USDC_ISSUER = "GCUSTOMUSDCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      process.env.SEP38_EURC_ISSUER = "GCUSTOMEURCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

      try {
        const config = getSep24Config();
        expect(config.assets.USDC.asset_issuer).toBe(process.env.SEP38_USDC_ISSUER);
        expect(config.assets.EURC.asset_issuer).toBe(process.env.SEP38_EURC_ISSUER);
      } finally {
        process.env.SEP38_USDC_ISSUER = prevUsdc;
        process.env.SEP38_EURC_ISSUER = prevEurc;
      }
    });
  });

  describe("getSep24Info", () => {
    it("lists all three assets under both deposit and withdraw", () => {
      const info = getSep24Info();
      expect(Object.keys(info.deposit).sort()).toEqual(["EURC", "USDC", "XLM"]);
      expect(Object.keys(info.withdraw).sort()).toEqual(["EURC", "USDC", "XLM"]);
    });
  });

  describe("initiateDeposit", () => {
    it("accepts a deposit request for USDC", async () => {
      const result = await initiateDeposit(depositRequest({ asset_code: "USDC" }));
      expect(result).toHaveProperty("url");
    });

    it("accepts a deposit request for EURC", async () => {
      const result = await initiateDeposit(depositRequest({ asset_code: "EURC" }));
      expect(result).toHaveProperty("url");
    });

    it("accepts a deposit request for XLM", async () => {
      const result = await initiateDeposit(depositRequest({ asset_code: "XLM" }));
      expect(result).toHaveProperty("url");
    });

    it("rejects a deposit for an unsupported asset code", async () => {
      await expect(
        initiateDeposit(depositRequest({ asset_code: "DOGE" })),
      ).rejects.toThrow(/not available for deposit/);
    });

    it("rejects a USDC deposit below the minimum amount", async () => {
      await expect(
        initiateDeposit(depositRequest({ asset_code: "USDC", amount: "0.5" })),
      ).rejects.toThrow(/Minimum deposit amount/);
    });

    it("rejects a USDC deposit above the maximum amount", async () => {
      await expect(
        initiateDeposit(depositRequest({ asset_code: "USDC", amount: "1000000" })),
      ).rejects.toThrow(/Maximum deposit amount/);
    });
  });

  describe("initiateWithdrawal", () => {
    it("accepts a withdrawal request for USDC", async () => {
      const result = await initiateWithdrawal(
        withdrawRequest({ asset_code: "USDC" }),
      );
      expect(result).toHaveProperty("url");
    });

    it("accepts a withdrawal request for EURC", async () => {
      const result = await initiateWithdrawal(
        withdrawRequest({ asset_code: "EURC" }),
      );
      expect(result).toHaveProperty("url");
    });

    it("rejects a withdrawal for an unsupported asset code", async () => {
      await expect(
        initiateWithdrawal(withdrawRequest({ asset_code: "DOGE" })),
      ).rejects.toThrow(/not available for withdrawal/);
    });
  });
});
