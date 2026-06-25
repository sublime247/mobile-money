import { pool } from "../config/database";

export interface TaxConfig {
  country: string; // ISO country code e.g., CMR, NGA, GHA
  vatRate: number; // e.g., 0.1925 for 19.25%
  transferTaxRate: number; // e.g., 0.01 for 1%
}

/**
 * Retrieves tax configuration for a given jurisdiction.
 * Falls back to a default of 0% rates if not found.
 */
export async function getTaxConfig(countryCode: string): Promise<TaxConfig> {
  const result = await pool.query(
    `SELECT country, vat_rate, transfer_tax_rate FROM tax_settings WHERE country = $1`,
    [countryCode.toUpperCase()],
  );

  if (result.rows.length === 0) {
    // No specific config – return zero rates so callers can handle gracefully.
    return { country: countryCode.toUpperCase(), vatRate: 0, transferTaxRate: 0 };
  }

  const row = result.rows[0];
  return {
    country: row.country,
    vatRate: parseFloat(row.vat_rate),
    transferTaxRate: parseFloat(row.transfer_tax_rate),
  };
}
