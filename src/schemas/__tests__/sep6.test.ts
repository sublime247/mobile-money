import {
  sep6InfoResponseSchema,
  sep6DepositAssetSchema,
  sep6WithdrawAssetSchema,
  validateSep6InfoResponse,
} from "../sep6";

describe("SEP-6 Schema Validation (#2268)", () => {
  const validDepositAsset = {
    enabled: true,
    authentication_required: false,
    min_amount: 1,
    max_amount: 10000,
    fee_fixed: 0.5,
    fee_percent: 1.5,
    fields: {
      email_address: {
        description: "Email address for notifications",
        optional: true,
      },
    },
  };

  const validWithdrawAsset = {
    enabled: true,
    authentication_required: true,
    min_amount: 5,
    max_amount: 5000,
    fee_fixed: 1.0,
    fee_percent: 2.0,
    types: {
      bank_account: {
        fields: {
          dest: { description: "Bank account number", optional: false },
        },
      },
    },
  };

  const validInfoPayload = {
    deposit: {
      XLM: validDepositAsset,
    },
    withdraw: {
      XLM: validWithdrawAsset,
    },
    fee: { enabled: true, description: "Dynamic corridor fees apply" },
    transactions: { enabled: true, authentication_required: true },
    transaction: { enabled: true, authentication_required: true },
    features: { account_creation: true, claimable_balances: true },
  };

  describe("sep6InfoResponseSchema", () => {
    it("successfully validates a fully compliant SEP-6 /info response", () => {
      const parsed = validateSep6InfoResponse(validInfoPayload);
      expect(parsed).toEqual(validInfoPayload);
    });

    it("rejects negative fee_fixed", () => {
      const invalid = {
        ...validInfoPayload,
        deposit: {
          XLM: {
            ...validDepositAsset,
            fee_fixed: -0.5,
          },
        },
      };

      expect(() => sep6InfoResponseSchema.parse(invalid)).toThrow(
        /fee_fixed must be greater than or equal to 0/,
      );
    });

    it("rejects negative fee_percent", () => {
      const invalid = {
        ...validInfoPayload,
        withdraw: {
          XLM: {
            ...validWithdrawAsset,
            fee_percent: -1,
          },
        },
      };

      expect(() => sep6InfoResponseSchema.parse(invalid)).toThrow(
        /fee_percent must be >= 0/,
      );
    });

    it("rejects fee_percent exceeding 100%", () => {
      const invalid = {
        ...validInfoPayload,
        deposit: {
          XLM: {
            ...validDepositAsset,
            fee_percent: 105,
          },
        },
      };

      expect(() => sep6InfoResponseSchema.parse(invalid)).toThrow(
        /fee_percent cannot exceed 100/,
      );
    });

    it("rejects missing min_amount or max_amount corridor limits", () => {
      const missingMin = {
        ...validDepositAsset,
      };
      delete (missingMin as any).min_amount;

      expect(() => sep6DepositAssetSchema.parse(missingMin)).toThrow(
        /min_amount/,
      );

      const missingMax = {
        ...validWithdrawAsset,
      };
      delete (missingMax as any).max_amount;

      expect(() => sep6WithdrawAssetSchema.parse(missingMax)).toThrow(
        /max_amount/,
      );
    });

    it("rejects min_amount greater than max_amount", () => {
      const invertedLimits = {
        ...validDepositAsset,
        min_amount: 500,
        max_amount: 100,
      };

      expect(() => sep6DepositAssetSchema.parse(invertedLimits)).toThrow(
        /max_amount must be greater than or equal to min_amount/,
      );
    });

    it("rejects non-positive max_amount", () => {
      const zeroMax = {
        ...validDepositAsset,
        min_amount: 0,
        max_amount: 0,
      };

      expect(() => sep6DepositAssetSchema.parse(zeroMax)).toThrow(
        /max_amount must be greater than 0/,
      );
    });

    it("validates endpoint capability flags", () => {
      const withCapabilities = {
        ...validInfoPayload,
        fee: { enabled: true },
        transactions: { enabled: true, authentication_required: true },
      };

      const result = sep6InfoResponseSchema.parse(withCapabilities);
      expect(result.fee?.enabled).toBe(true);
      expect(result.transactions?.enabled).toBe(true);
      expect(result.transactions?.authentication_required).toBe(true);
    });
  });
});
