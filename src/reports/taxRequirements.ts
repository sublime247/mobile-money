// Tax requirements for CMR, NGA, GHA
// This file documents the tax mapping for each supported jurisdiction.

export const taxRequirements = {
  CMR: {
    vatRate: 0.1925, // 19.25% VAT
    transferTaxRate: 0.01, // 1% transfer tax
    formats: ["CSV", "XML"],
    notes: "Cameroon VAT and transfer tax. CSV/XML required.",
  },
  NGA: {
    vatRate: 0.075, // 7.5% VAT
    transferTaxRate: 0.01, // 1% transfer tax
    formats: ["CSV", "XML"],
    notes: "Nigeria VAT and transfer tax. CSV/XML required.",
  },
  GHA: {
    vatRate: 0.125, // 12.5% VAT
    transferTaxRate: 0.015, // 1.5% transfer tax
    formats: ["CSV", "XML"],
    notes: "Ghana VAT and transfer tax. CSV/XML required.",
  },
};
