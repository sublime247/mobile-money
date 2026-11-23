/**
 * Country-specific national ID format validation for SEP-31 (#2429).
 *
 * Rules are deliberately permissive about *presence*: an ID is only checked
 * when the request declares a supported country AND supplies an ID number.
 * Unknown countries and missing IDs pass so existing corridors keep working.
 * Both ISO 3166-1 alpha-2 and alpha-3 codes are accepted.
 *
 * Supported formats:
 *   Ghana    (GH / GHA) - GHA-XXXXXXXXX-X: literal "GHA-", 9 digits, "-",
 *                           then one alphanumeric check character.
 *   Kenya    (KE / KEN) - 7 or 8 digits (national ID number).
 *   Nigeria  (NG / NGA) - exactly 11 digits (NIN).
 *   Senegal  (SN / SEN) - exactly 13 digits (CNI number). Senegal's CNI is a
 *                          13-digit numeric identifier; no published public
 *                          checksum rule is applied here, only the length and
 *                          character-class rule.
 */

export type SupportedNationalIdCountry = "GH" | "KE" | "NG" | "SN";

interface NationalIdRule {
  alpha2: SupportedNationalIdCountry;
  alpha3: string;
  /** Human-readable description used in validation errors. */
  expected: string;
  pattern: RegExp;
}

const NATIONAL_ID_RULES: readonly NationalIdRule[] = [
  {
    alpha2: "GH",
    alpha3: "GHA",
    expected: "GHA-XXXXXXXXX-X (9 digits followed by an alphanumeric check character)",
    pattern: /^GHA-\d{9}-[A-Z0-9]$/i,
  },
  {
    alpha2: "KE",
    alpha3: "KEN",
    expected: "7 or 8 digits",
    pattern: /^\d{7,8}$/,
  },
  {
    alpha2: "NG",
    alpha3: "NGA",
    expected: "11 digits (NIN)",
    pattern: /^\d{11}$/,
  },
  {
    alpha2: "SN",
    alpha3: "SEN",
    expected: "13 digits (CNI)",
    pattern: /^\d{13}$/,
  },
];

const RULE_BY_COUNTRY: ReadonlyMap<string, NationalIdRule> = new Map(
  NATIONAL_ID_RULES.flatMap((rule) => [
    [rule.alpha2, rule],
    [rule.alpha3, rule],
  ]),
);

export function isSupportedNationalIdCountry(
  countryCode: string | null | undefined,
): boolean {
  if (!countryCode) return false;
  return RULE_BY_COUNTRY.has(countryCode.trim().toUpperCase());
}

export interface NationalIdValidationResult {
  valid: boolean;
  country?: SupportedNationalIdCountry;
  error?: string;
}

/**
 * Validates one national ID number against the rule for `countryCode`.
 *
 * Returns `{ valid: true }` without a country when no supported country is
 * declared, or when the ID number is absent/empty — SEP-31 requests for other
 * corridors must not be broken by this check.
 */
export function validateNationalId(
  idNumber: string | number | null | undefined,
  countryCode: string | null | undefined,
  fieldName = "id_number",
): NationalIdValidationResult {
  if (idNumber === undefined || idNumber === null) return { valid: true };

  const normalizedId = String(idNumber).trim();
  if (normalizedId === "") return { valid: true };

  const rule = countryCode
    ? RULE_BY_COUNTRY.get(countryCode.trim().toUpperCase())
    : undefined;
  if (!rule) return { valid: true };

  if (rule.pattern.test(normalizedId)) {
    return { valid: true, country: rule.alpha2 };
  }

  return {
    valid: false,
    country: rule.alpha2,
    error: `${fieldName} has an invalid format for ${countryCode?.trim().toUpperCase()} (expected ${rule.expected})`,
  };
}

export interface Sep31NationalIdValidationResult {
  valid: boolean;
  /** Field paths (SEP-9 dot notation) whose ID number failed validation. */
  invalidFields: string[];
  error?: string;
}

/**
 * Reads a SEP-9 field from `fields.sender` / `fields.receiver`, the legacy
 * `fields.sender_fields` / `fields.receiver_fields` aliases, or the flat
 * `fields.sender_<name>` form already supported by the SEP-31 KYC validator.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readSep9Field(
  fields: Record<string, unknown>,
  party: "sender" | "receiver",
  key: string,
): unknown {
  const partyFields = asRecord(fields[party] ?? fields[`${party}_fields`]);
  return partyFields[key] ?? fields[`${party}_${key}`];
}

/**
 * Validates `fields.sender.id_number` and `fields.receiver.id_number`.
 *
 * Each party's `id_country_code` takes precedence; when absent, the
 * top-level transaction/corridor country is used. Only declared supported
 * countries with a present ID are enforced.
 */
export function validateSep31NationalIds(
  fields: Record<string, unknown> = {},
  fallbackCountryCode?: string,
): Sep31NationalIdValidationResult {
  const invalidFields: string[] = [];
  const errors: string[] = [];

  for (const party of ["sender", "receiver"] as const) {
    const result = validateNationalId(
      readSep9Field(fields, party, "id_number") as
        | string
        | number
        | null
        | undefined,
      (readSep9Field(fields, party, "id_country_code") as string | undefined) ||
        fallbackCountryCode,
      `fields.${party}.id_number`,
    );

    if (!result.valid) {
      invalidFields.push(`fields.${party}.id_number`);
      errors.push(result.error || `fields.${party}.id_number is invalid`);
    }
  }

  return {
    valid: invalidFields.length === 0,
    invalidFields,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}
