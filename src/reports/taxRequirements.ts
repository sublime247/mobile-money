// Tax requirements for CMR, NGA, GHA
// This file documents the tax mapping for each supported jurisdiction.
// Rates can be overridden via environment variables:
//   TAX_CMR_VAT, TAX_CMR_TRANSFER
//   TAX_NGA_VAT, TAX_NGA_TRANSFER
//   TAX_GHA_VAT, TAX_GHA_TRANSFER

const parseRate = (envVar: string | undefined, defaultRate: number): number =>
  envVar !== undefined ? parseFloat(envVar) : defaultRate;

export const taxRequirements = {
  CMR: {
    vatRate: parseRate(process.env.TAX_CMR_VAT, 0.1925), // 19.25% VAT
    transferTaxRate: parseRate(process.env.TAX_CMR_TRANSFER, 0.01), // 1% transfer tax
    formats: ["CSV", "XML"],
    notes: "Cameroon VAT and transfer tax. CSV/XML required."
  },
  NGA: {
    vatRate: parseRate(process.env.TAX_NGA_VAT, 0.075), // 7.5% VAT
    transferTaxRate: parseRate(process.env.TAX_NGA_TRANSFER, 0.01), // 1% transfer tax
    formats: ["CSV", "XML"],
    notes: "Nigeria VAT and transfer tax. CSV/XML required."
  },
  GHA: {
    vatRate: parseRate(process.env.TAX_GHA_VAT, 0.125), // 12.5% VAT
    transferTaxRate: parseRate(process.env.TAX_GHA_TRANSFER, 0.015), // 1.5% transfer tax
    formats: ["CSV", "XML"],
    notes: "Ghana VAT and transfer tax. CSV/XML required."
  }
};
