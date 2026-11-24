export interface FeeDetail {
  description: string;
  amount: string;
}

export interface FeeCalculation {
  fee: number;
  total: number;
  feeDetails: FeeDetail[];
}

export interface FeeCalculationConfig {
  baseNetworkFee?: number;
  providerProcessingFee?: number;
  fxConversionMarginPercent?: number;
}

const DECIMAL_PLACES = 7;
const UNIT = 10 ** DECIMAL_PLACES;

function toUnits(amount: number): number {
  return Math.round(amount * UNIT);
}

function formatAmount(units: number): string {
  return (units / UNIT).toFixed(DECIMAL_PLACES).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

/**
 * Calculates the SEP-31 fee and keeps each component on the same rounded
 * precision used by Stellar asset amounts so the itemized sum is exact.
 */
export function calculateFee(
  amount: number,
  config: FeeCalculationConfig = {},
): FeeCalculation {
  const baseNetworkFee = toUnits(
    config.baseNetworkFee ?? parseFloat(process.env.SEP31_BASE_NETWORK_FEE || "0"),
  );
  const providerProcessingFee = toUnits(
    config.providerProcessingFee ?? parseFloat(process.env.SEP31_FEE_FIXED || "1.00"),
  );
  const fxConversionMargin = toUnits(
    (amount *
      (config.fxConversionMarginPercent ??
        parseFloat(process.env.SEP31_FEE_PERCENT || "0.5"))) /
      100,
  );

  const feeUnits = baseNetworkFee + providerProcessingFee + fxConversionMargin;
  const fee = feeUnits / UNIT;

  return {
    fee,
    total: parseFloat((amount + fee).toFixed(DECIMAL_PLACES)),
    feeDetails: [
      {
        description: "Base network fee",
        amount: formatAmount(baseNetworkFee),
      },
      {
        description: "Provider processing fee",
        amount: formatAmount(providerProcessingFee),
      },
      {
        description: "FX conversion margin",
        amount: formatAmount(fxConversionMargin),
      },
    ],
  };
}
