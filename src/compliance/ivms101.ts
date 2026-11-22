/**
 * IVMS 101 Data Model Serializer — issue #2466
 *
 * Implements the FATF Travel Rule IVMS 101 (interVASP Messaging Standard)
 * data format for cross-border remittances exceeding EUR/USD 1,000 equivalent.
 *
 * Reference: https://intervasp.org/ivms101/
 *
 * The IVMS 101 standard defines three top-level objects:
 *   - Originator   — the sender (customer initiating the transfer)
 *   - Beneficiary  — the recipient
 *   - VASP         — virtual asset service provider identifiers
 *
 * This module:
 *   1. Defines the IVMS 101 TypeScript interfaces
 *   2. Provides buildIVMS101Payload() to construct a valid payload from
 *      TravelRuleParty records already captured by the Travel Rule service
 *   3. Validates mandatory fields and throws descriptive errors on missing data
 */

import type { TravelRuleParty, TravelRuleRecord } from "./travelRule.js";

// ---------------------------------------------------------------------------
// IVMS 101 Type definitions
// ---------------------------------------------------------------------------

/** IVMS 101 §3.1 — Natural person name identifiers */
export interface IVMS101NaturalPersonNameId {
  primaryIdentifier: string;   // last name / full name
  secondaryIdentifier?: string; // first / given name
  nameIdentifierType:
    | "ALIA" // Alias
    | "BIRT" // Name at birth
    | "MAID" // Maiden name
    | "LEGL" // Legal name
    | "MISC";
}

/** IVMS 101 §3.2 — Legal person name identifiers */
export interface IVMS101LegalPersonNameId {
  legalPersonName: string;
  legalPersonNameIdentifierType: "LEGL" | "SHRT" | "TRAD";
}

/** IVMS 101 §3.3 — National identifier */
export interface IVMS101NationalIdentifier {
  nationalIdentifier: string;
  nationalIdentifierType:
    | "ARNU" // Alien registration number
    | "CCPT" // Passport number
    | "RAID" // Registration authority identifier
    | "DRLC" // Driver's licence
    | "FIIN" // Foreign investment identity number
    | "TXID" // Tax identification number
    | "SOCS" // Social security number
    | "IDCD" // Identity card number
    | "LEIX" // Legal entity identifier
    | "MISC";
  countryOfIssue?: string; // ISO 3166-1 alpha-2
}

/** IVMS 101 §3.4 — Geographic address */
export interface IVMS101Address {
  addressType: "GEOG" | "BIZZ" | "HOME";
  streetName?: string;
  buildingNumber?: string;
  buildingName?: string;
  floor?: string;
  postBox?: string;
  room?: string;
  postCode?: string;
  townName?: string;
  countrySubDivision?: string;
  country: string; // ISO 3166-1 alpha-2
}

/** IVMS 101 natural person */
export interface IVMS101NaturalPerson {
  name: { nameIdentifiers: IVMS101NaturalPersonNameId[] };
  geographicAddress?: IVMS101Address[];
  nationalIdentification?: IVMS101NationalIdentifier;
  dateAndPlaceOfBirth?: {
    dateOfBirth: string; // YYYY-MM-DD
    placeOfBirth?: string;
  };
  countryOfResidence?: string;
}

/** IVMS 101 originator/beneficiary account */
export interface IVMS101Person {
  naturalPerson?: IVMS101NaturalPerson;
}

/** IVMS 101 originator block */
export interface IVMS101Originator {
  originatorPersons: IVMS101Person[];
  accountNumber: string[];
}

/** IVMS 101 beneficiary block */
export interface IVMS101Beneficiary {
  beneficiaryPersons: IVMS101Person[];
  accountNumber: string[];
}

/** IVMS 101 VASP identifier */
export interface IVMS101VASP {
  name?: string;
  legalPersonIdentification?: {
    legalPersonName: string;
    legalPersonNameIdentifierType: "LEGL" | "SHRT" | "TRAD";
  };
}

/** Full IVMS 101 payload (top-level Transfer object) */
export interface IVMS101Payload {
  IVMS101Version: "2019-01-21";
  originator: IVMS101Originator;
  beneficiary: IVMS101Beneficiary;
  originatingVASP?: IVMS101VASP;
  beneficiaryVASP?: IVMS101VASP;
  transferPath?: unknown;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface IVMS101ValidationResult {
  valid: boolean;
  errors: string[];
}

const MANDATORY_ORIGINATOR_FIELDS = ["name", "account"] as const;
const MANDATORY_BENEFICIARY_FIELDS = ["name", "account"] as const;

/**
 * Validate that mandatory IVMS 101 fields are present on both parties.
 *
 * Per FATF Recommendation 16, the following are mandatory for the originator:
 *   - Legal name, account number, (address OR national ID OR date+place of birth)
 *
 * For the beneficiary: legal name and account number are the minimum.
 */
export function validateIVMS101Input(
  sender: TravelRuleParty,
  receiver: TravelRuleParty,
): IVMS101ValidationResult {
  const errors: string[] = [];

  // Originator mandatory fields
  for (const field of MANDATORY_ORIGINATOR_FIELDS) {
    if (!sender[field]) {
      errors.push(`Originator missing mandatory field: ${field}`);
    }
  }

  // At least one of: address, national ID, or date of birth
  if (!sender.address && !sender.idNumber && !sender.dob) {
    errors.push(
      "Originator must provide at least one of: address, national identifier, or date of birth",
    );
  }

  // Beneficiary mandatory fields
  for (const field of MANDATORY_BENEFICIARY_FIELDS) {
    if (!receiver[field]) {
      errors.push(`Beneficiary missing mandatory field: ${field}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Parse a free-text address string into an IVMS 101 Address object.
 * Best-effort: maps the entire string to streetName; country defaults to "ZZ"
 * (unknown) unless the string ends with a 2-letter uppercase code.
 */
function parseAddress(raw: string): IVMS101Address {
  const countryMatch = raw.match(/\b([A-Z]{2})$/);
  const country = countryMatch ? countryMatch[1] : "ZZ";
  return {
    addressType: "GEOG",
    streetName: raw,
    country,
  };
}

/**
 * Split a full name string into primary (last) and secondary (first) identifiers.
 * Handles single-word names by using the entire string as primaryIdentifier.
 */
function splitName(
  fullName: string,
): IVMS101NaturalPersonNameId {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return {
      primaryIdentifier: parts[0],
      nameIdentifierType: "LEGL",
    };
  }
  // Convention: first word(s) = secondary (given), last word = primary (family)
  const primary = parts[parts.length - 1];
  const secondary = parts.slice(0, parts.length - 1).join(" ");
  return {
    primaryIdentifier: primary,
    secondaryIdentifier: secondary,
    nameIdentifierType: "LEGL",
  };
}

/**
 * Build a full IVMS 101 payload from Travel Rule party records.
 *
 * @throws Error if mandatory validation fails and `strict` is true (default).
 */
export function buildIVMS101Payload(
  sender: TravelRuleParty,
  receiver: TravelRuleParty,
  options: {
    originatingVasp?: string;
    beneficiaryVasp?: string;
    /** Throw on validation errors (default: true) */
    strict?: boolean;
  } = {},
): IVMS101Payload {
  const strict = options.strict !== false;

  const validation = validateIVMS101Input(sender, receiver);
  if (!validation.valid && strict) {
    throw new Error(
      `IVMS 101 validation failed: ${validation.errors.join("; ")}`,
    );
  }

  // ── Originator ────────────────────────────────────────────────────────────
  const originatorPerson: IVMS101NaturalPerson = {
    name: { nameIdentifiers: [splitName(sender.name)] },
  };

  if (sender.address) {
    originatorPerson.geographicAddress = [parseAddress(sender.address)];
  }

  if (sender.idNumber) {
    originatorPerson.nationalIdentification = {
      nationalIdentifier: sender.idNumber,
      nationalIdentifierType: "MISC",
    };
  }

  if (sender.dob) {
    originatorPerson.dateAndPlaceOfBirth = { dateOfBirth: sender.dob };
  }

  // ── Beneficiary ───────────────────────────────────────────────────────────
  const beneficiaryPerson: IVMS101NaturalPerson = {
    name: { nameIdentifiers: [splitName(receiver.name)] },
  };

  if (receiver.address) {
    beneficiaryPerson.geographicAddress = [parseAddress(receiver.address)];
  }

  // ── VASP blocks ───────────────────────────────────────────────────────────
  const originatingVASP: IVMS101VASP | undefined = options.originatingVasp
    ? {
        name: options.originatingVasp,
        legalPersonIdentification: {
          legalPersonName: options.originatingVasp,
          legalPersonNameIdentifierType: "LEGL",
        },
      }
    : undefined;

  const beneficiaryVASP: IVMS101VASP | undefined = options.beneficiaryVasp
    ? {
        name: options.beneficiaryVasp,
        legalPersonIdentification: {
          legalPersonName: options.beneficiaryVasp,
          legalPersonNameIdentifierType: "LEGL",
        },
      }
    : undefined;

  return {
    IVMS101Version: "2019-01-21",
    originator: {
      originatorPersons: [{ naturalPerson: originatorPerson }],
      accountNumber: [sender.account],
    },
    beneficiary: {
      beneficiaryPersons: [{ naturalPerson: beneficiaryPerson }],
      accountNumber: [receiver.account],
    },
    ...(originatingVASP && { originatingVASP }),
    ...(beneficiaryVASP && { beneficiaryVASP }),
  };
}

/**
 * Convenience wrapper — build an IVMS 101 payload directly from a
 * TravelRuleRecord (already captured by the Travel Rule service).
 */
export function buildIVMS101FromRecord(
  record: TravelRuleRecord,
  options: { strict?: boolean } = {},
): IVMS101Payload {
  return buildIVMS101Payload(record.sender, record.receiver, {
    originatingVasp: record.originatingVasp,
    beneficiaryVasp: record.beneficiaryVasp,
    strict: options.strict,
  });
}
