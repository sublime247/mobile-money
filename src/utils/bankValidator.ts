/**
 * CEMAC bank account (RIB) validation for SEP-6 withdrawals (#2431).
 *
 * The CEMAC "Relevé d'Identité Bancaire" is 23 digits laid out as:
 *   5-digit bank code | 5-digit branch code | 11-digit account number | 2-digit key
 *
 * Checksum algorithm (modulo 97):
 *   1. Strip whitespace and common grouping separators from the RIB.
 *   2. Require exactly 23 digits.
 *   3. Let `remainder = Number(first21Digits % 97)`.
 *   4. The expected key is `97 - remainder` (two digits), and must equal the
 *      two digits supplied in positions 22-23.
 *
 * The key comparison above is the authoritative RIB rule. (The sometimes
 * quoted "full 23-digit number % 97 == 1" formulation applies to the
 * rearranged IBAN check-string convention, not to a RIB with a trailing
 * two-digit key, so it is deliberately not used here.)
 *
 * Supported countries: Cameroon (CM/CMR), Gabon (GA/GAB), Chad (TD/TCD)
 * and Congo (CG/COG). Unknown countries are not validated, so non-CEMAC
 * corridors keep their existing bank-account rules.
 */

export const CEMAC_COUNTRY_CODES = {
  CM: "CMR",
  GA: "GAB",
  TD: "TCD",
  CG: "COG",
} as const;

export type CemacAlpha2 = keyof typeof CEMAC_COUNTRY_CODES;
export type CemacCountryCode = CemacAlpha2 | (typeof CEMAC_COUNTRY_CODES)[CemacAlpha2];

const ALPHA3_TO_ALPHA2: Readonly<Record<string, CemacAlpha2>> = {
  CMR: "CM",
  GAB: "GA",
  TCD: "TD",
  COG: "CG",
};

export function getCemacCountryCode(
  countryCode: string | null | undefined,
): CemacAlpha2 | undefined {
  if (!countryCode) return undefined;
  const normalized = countryCode.trim().toUpperCase();
  if (normalized in CEMAC_COUNTRY_CODES) {
    return normalized as CemacAlpha2;
  }
  return ALPHA3_TO_ALPHA2[normalized];
}

export function isCemacCountry(
  countryCode: string | null | undefined,
): boolean {
  return getCemacCountryCode(countryCode) !== undefined;
}

/** Removes spaces, line breaks and common grouping punctuation from a RIB. */
export function normalizeRib(rib: string | number | null | undefined): string {
  if (rib === null || rib === undefined) return "";
  return String(rib).replace(/[\s\-._/]/g, "");
}

export interface RibValidationResult {
  valid: boolean;
  country?: CemacAlpha2;
  normalizedRib?: string;
  error?: string;
}

/**
 * Validates a CEMAC RIB.
 *
 * Validation is applied when the caller declares a supported CEMAC country,
 * or when a 23-digit value is supplied without a country (a value shaped
 * like a RIB is held to the RIB checksum). Missing values and short account
 * numbers for undeclared/non-CEMAC countries pass unchanged.
 */
export function validateCemacRib(
  rib: string | number | null | undefined,
  countryCode?: string | null,
  fieldName = "dest",
): RibValidationResult {
  const country = getCemacCountryCode(countryCode);
  const normalizedRib = normalizeRib(rib);

  if (!normalizedRib) return { valid: true, country };
  if (countryCode && !country) return { valid: true };
  if (!country && !/^\d{23}$/.test(normalizedRib)) return { valid: true };

  if (!/^\d{23}$/.test(normalizedRib)) {
    return {
      valid: false,
      country,
      normalizedRib,
      error: `${fieldName} must be a 23-digit CEMAC RIB (bank code + branch code + 11-digit account number + 2-digit key)`,
    };
  }

  const remainder = Number(BigInt(normalizedRib.slice(0, 21)) % 97n);
  const expectedKey = String(97 - remainder).padStart(2, "0");
  const suppliedKey = normalizedRib.slice(21);

  if (suppliedKey !== expectedKey) {
    return {
      valid: false,
      country,
      normalizedRib,
      error: `${fieldName} failed the CEMAC RIB checksum: expected key ${expectedKey}, received ${suppliedKey}${country ? ` for ${country}` : ""}`,
    };
  }

  return { valid: true, country, normalizedRib };
}
